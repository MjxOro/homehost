package worker

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Raw SQL against the API's tables: names must match apps/api/migrations.

type job struct {
	id        string
	requestID string
	action    string
	attempts  int
	timer     *phaseTimer
}

type request struct {
	id           string
	ownerID      string
	ownerName    string
	name         string
	planID       string
	status       string
	instanceName *string
	sshPubkey    *string
	subdomain    string
}

// leaseJob takes the oldest queued job: queued -> leased, attempts++.
func (w *Worker) leaseJob(ctx context.Context) (*job, error) {
	var j *job
	err := pgx.BeginFunc(ctx, w.db, func(tx pgx.Tx) error {
		var found job
		var queuedMs int64
		err := tx.QueryRow(ctx, `
			SELECT id::text, request_id::text, action, attempts,
				(extract(epoch FROM clock_timestamp() - created_at) * 1000)::bigint
			FROM provision_jobs
			WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
		`).Scan(&found.id, &found.requestID, &found.action, &found.attempts, &queuedMs)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		found.attempts++
		found.timer = newPhaseTimer(time.Duration(queuedMs) * time.Millisecond)
		if _, err := tx.Exec(ctx, `
			UPDATE provision_jobs SET status = 'leased', attempts = $1, updated_at = now()
			WHERE id = $2
		`, found.attempts, found.id); err != nil {
			return err
		}
		j = &found
		return nil
	})
	return j, err
}

func (w *Worker) loadRequest(ctx context.Context, requestID string) (*request, error) {
	var r request
	err := w.db.QueryRow(ctx, `
		SELECT id::text, owner_id, owner_name, name, plan_id, status, instance_name, ssh_pubkey, subdomain
		FROM server_requests WHERE id = $1 LIMIT 1
	`, requestID).Scan(&r.id, &r.ownerID, &r.ownerName, &r.name, &r.planID, &r.status, &r.instanceName, &r.sshPubkey, &r.subdomain)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// setRequest moves the row to status and overwrites instance_name and ipv4
// (nil clears them).
func (w *Worker) setRequest(ctx context.Context, requestID, status string, instanceName, ipv4 *string) error {
	_, err := w.db.Exec(ctx, `
		UPDATE server_requests
		SET status = $2, instance_name = $3, ipv4 = $4, updated_at = now()
		WHERE id = $1
	`, requestID, status, instanceName, ipv4)
	return err
}

func (w *Worker) setInstancePassword(ctx context.Context, requestID, password string) error {
	_, err := w.db.Exec(ctx, `
		UPDATE server_requests SET instance_password = $2, updated_at = now() WHERE id = $1
	`, requestID, password)
	return err
}

func (w *Worker) setDesktopPassword(ctx context.Context, requestID string, password *string) error {
	_, err := w.db.Exec(ctx, `
		UPDATE server_requests SET desktop_password = $2, updated_at = now() WHERE id = $1
	`, requestID, password)
	return err
}

var (
	errIpv6RequestMissing = errors.New("IPv6 assignment request missing")
	errIpv6Taken          = errors.New("IPv6 address already assigned or owner missing")
)

// setIpv6 stores the request's address and opens its ip_assignments row in
// one transaction. A retry keeps the original snapshot; an address held by
// another request fails and rolls back the request update too.
func (w *Worker) setIpv6(ctx context.Context, requestID, ipv6 string) error {
	return pgx.BeginFunc(ctx, w.db, func(tx pgx.Tx) error {
		// Lock the request so simultaneous retries cannot rotate its ledger twice.
		tag, err := tx.Exec(ctx, `
			UPDATE server_requests SET ipv6 = $2, updated_at = now() WHERE id = $1
		`, requestID, ipv6)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errIpv6RequestMissing
		}
		if _, err := tx.Exec(ctx, `
			UPDATE ip_assignments SET released_at = now()
			WHERE request_id = $1 AND released_at IS NULL AND address <> $2::inet
		`, requestID, ipv6); err != nil {
			return err
		}
		tag, err = tx.Exec(ctx, `
			INSERT INTO ip_assignments
				(request_id, user_id, owner_name, owner_email, address, subdomain, prefix)
			SELECT r.id, r.owner_id, u.name, u.email, $2::inet, r.subdomain,
				network(set_masklen($2::inet, 64))::text
			FROM server_requests r JOIN users u ON u.id = r.owner_id
			WHERE r.id = $1
			ON CONFLICT (address) WHERE released_at IS NULL
			DO UPDATE SET address = EXCLUDED.address
				WHERE ip_assignments.request_id = EXCLUDED.request_id
		`, requestID, ipv6)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errIpv6Taken
		}
		return nil
	})
}

func (w *Worker) releaseIpv6(ctx context.Context, requestID string) error {
	_, err := w.db.Exec(ctx, `
		UPDATE ip_assignments SET released_at = now()
		WHERE request_id = $1 AND released_at IS NULL
	`, requestID)
	return err
}

// reconcileIpv6Assignments opens ledger rows for live requests holding an
// ipv6 but no open assignment (boxes provisioned between the 0013 backfill
// and this worker's restart). Same idempotent insert as the backfill.
// Returns the rows inserted.
func (w *Worker) reconcileIpv6Assignments(ctx context.Context) (int64, error) {
	tag, err := w.db.Exec(ctx, `
		INSERT INTO ip_assignments
			(request_id, user_id, owner_name, owner_email, address, subdomain, prefix, assigned_at)
		SELECT r.id, r.owner_id, COALESCE(u.name, r.owner_name), u.email,
			r.ipv6::inet, r.subdomain, network(set_masklen(r.ipv6::inet, 64))::text,
			LEAST(COALESCE((SELECT MIN(e.created_at) FROM activity_events e
				WHERE e.request_id = r.id AND e.action = 'running'),
				r.created_at), r.updated_at)
		FROM server_requests r
		LEFT JOIN users u ON u.id = r.owner_id
		WHERE r.ipv6 IS NOT NULL AND r.ipv6 ~ '^[0-9a-fA-F:]+$'
			AND r.status NOT IN ('rejected', 'deleted')
			AND NOT EXISTS (SELECT 1 FROM ip_assignments a
				WHERE a.request_id = r.id AND a.released_at IS NULL)
		ON CONFLICT (address) WHERE released_at IS NULL DO NOTHING
	`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

type desktopFields struct {
	env      *string
	hostname *string
	port     *int32
}

// loadDesktopFields reads the migration-0010 desktop columns. Any failure
// returns nil so callers fall back to plan-derived values.
func (w *Worker) loadDesktopFields(ctx context.Context, requestID string) *desktopFields {
	var f desktopFields
	err := w.db.QueryRow(ctx, `
		SELECT desktop_env, desktop_hostname, desktop_port FROM server_requests WHERE id = $1 LIMIT 1
	`, requestID).Scan(&f.env, &f.hostname, &f.port)
	if err != nil {
		return nil
	}
	return &f
}

func (w *Worker) emit(ctx context.Context, requestID, actorName, action, serverName string, detail *string) error {
	_, err := w.db.Exec(ctx, `
		INSERT INTO activity_events (request_id, actor_name, action, server_name, detail)
		VALUES ($1, $2, $3, $4, $5)
	`, requestID, actorName, action, serverName, detail)
	return err
}

func (w *Worker) finishJob(ctx context.Context, j *job, status string, lastError *string) error {
	timings, err := j.timer.json(j.attempts)
	if err != nil {
		return err
	}
	_, err = w.db.Exec(ctx, `
		UPDATE provision_jobs SET status = $2, last_error = $3, timings = $4, updated_at = now() WHERE id = $1
	`, j.id, status, lastError, timings)
	return err
}

// markBuilt stores how long the box took to become usable, measured from the
// latest provision request (approval or retry): the web UI's "Built in ...".
// A box with recipe setup still outstanding is not built yet: no-op.
// The ready event just emitted ('running' or 'setup_done') carries the same
// duration for the activity feed.
func (w *Worker) markBuilt(ctx context.Context, requestID string) error {
	_, err := w.db.Exec(ctx, `
		WITH built AS (
			UPDATE server_requests r
			SET build_ms = (extract(epoch FROM clock_timestamp() - s.started_at) * 1000)::int
			FROM (SELECT max(created_at) AS started_at FROM provision_jobs
				WHERE request_id = $1 AND action = 'provision') s
			WHERE r.id = $1 AND s.started_at IS NOT NULL AND r.setup_status IN ('none', 'done')
			RETURNING r.id, r.build_ms
		)
		UPDATE activity_events e SET build_ms = built.build_ms
		FROM built
		WHERE e.id = (
			SELECT id FROM activity_events
			WHERE request_id = built.id AND action IN ('running', 'setup_done')
			ORDER BY created_at DESC, id DESC LIMIT 1
		)
	`, requestID)
	return err
}

func (w *Worker) requeue(ctx context.Context, jobID, lastError string) error {
	_, err := w.db.Exec(ctx, `
		UPDATE provision_jobs SET status = 'queued', last_error = $2, updated_at = now() WHERE id = $1
	`, jobID, lastError)
	return err
}

// requeueLeased is crash recovery: leases die with the process.
func (w *Worker) requeueLeased(ctx context.Context) error {
	_, err := w.db.Exec(ctx, `UPDATE provision_jobs SET status = 'queued', updated_at = now() WHERE status = 'leased'`)
	return err
}

// enqueueSetupIfPending queues the recipe install for a running box whose
// setup has not run yet. The partial unique index allows one active setup
// job per request.
func (w *Worker) enqueueSetupIfPending(ctx context.Context, requestID string) error {
	_, err := w.db.Exec(ctx, `
		INSERT INTO provision_jobs (request_id, action)
		SELECT id, 'setup' FROM server_requests
		WHERE id = $1 AND status = 'running' AND setup_status = 'pending'
		ON CONFLICT (request_id, action) WHERE status IN ('queued', 'leased')
		DO NOTHING
	`, requestID)
	return err
}

type setupState struct {
	recipeID     *string
	setupStatus  string
	eulaAccepted bool
	ipv6         *string
}

func (w *Worker) loadSetupState(ctx context.Context, requestID string) (*setupState, error) {
	var s setupState
	err := w.db.QueryRow(ctx, `
		SELECT recipe_id, setup_status, eula_accepted_at IS NOT NULL, ipv6
		FROM server_requests WHERE id = $1 LIMIT 1
	`, requestID).Scan(&s.recipeID, &s.setupStatus, &s.eulaAccepted, &s.ipv6)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (w *Worker) setSetup(ctx context.Context, requestID, status string, step, code *string) error {
	_, err := w.db.Exec(ctx, `
		UPDATE server_requests
		SET setup_status = $2, setup_step = $3, setup_error = $4, updated_at = now()
		WHERE id = $1
	`, requestID, status, step, code)
	return err
}
