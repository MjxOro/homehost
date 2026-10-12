package worker

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// bootingIncus launches every instance straight to Running with an address.
type bootingIncus struct {
	Incus
}

func (bootingIncus) EnsureProject(context.Context, string) error { return nil }

func (bootingIncus) Delete(context.Context, string, string) error { return ErrNotFound }

func (bootingIncus) Launch(context.Context, string, string, LaunchSpec) error { return nil }

func (bootingIncus) State(context.Context, string, string) (InstanceState, error) {
	return InstanceState{Status: "Running", IPv4: "10.0.0.9"}, nil
}

func (bootingIncus) Exec(context.Context, string, string, []string, time.Duration) ExecResult {
	zero := 0
	return ExecResult{ExitCode: &zero}
}

func provisionLeased(t *testing.T, db *pgxpool.Pool, requestID string) *job {
	t.Helper()
	ctx := context.Background()
	w := New(Config{ProvisionAttempts: 5, BootTimeout: time.Minute, RoutesDir: os.TempDir()},
		db, bootingIncus{}, nil, log.New(io.Discard, "", 0))
	if _, err := db.Exec(ctx, `INSERT INTO provision_jobs (request_id, action) VALUES ($1, 'provision')`, requestID); err != nil {
		t.Fatal(err)
	}
	j, err := w.leaseJob(ctx)
	if err != nil || j == nil {
		t.Fatalf("lease = %v, %v", j, err)
	}
	if err := w.handleProvision(ctx, j); err != nil {
		t.Fatal(err)
	}
	return j
}

func TestProvisionRecordsPhaseTimingsAndBuildTime(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	o := fixture(t, db, "approved", nil)
	j := provisionLeased(t, db, o.requestID)

	var status string
	var raw []byte
	if err := db.QueryRow(ctx, `SELECT status, timings FROM provision_jobs WHERE id = $1`, j.id).Scan(&status, &raw); err != nil {
		t.Fatal(err)
	}
	if status != "done" {
		t.Fatalf("job status = %s, want done", status)
	}
	var got jobTimings
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("timings %s: %v", raw, err)
	}
	var names []string
	for _, p := range got.Phases {
		names = append(names, p.Name)
	}
	// No IPv6 prefix configured: no DNS publish and no readiness gate.
	want := []string{"prepare", "launch", "boot", "container_ssh", "finalize"}
	if got.Attempt != 1 || !reflect.DeepEqual(names, want) {
		t.Fatalf("timings = attempt %d phases %v, want attempt 1 phases %v", got.Attempt, names, want)
	}

	var buildMs, eventBuildMs *int
	if err := db.QueryRow(ctx, `SELECT r.build_ms,
		(SELECT build_ms FROM activity_events WHERE request_id = r.id AND action = 'running')
		FROM server_requests r WHERE r.id = $1`, o.requestID).Scan(&buildMs, &eventBuildMs); err != nil {
		t.Fatal(err)
	}
	if buildMs == nil || *buildMs < 0 || eventBuildMs == nil || *eventBuildMs != *buildMs {
		t.Fatalf("build_ms = %v, running event build_ms = %v; want the same non-negative duration on both", buildMs, eventBuildMs)
	}
}

func TestProvisionLeavesBuildTimeUnsetWhileSetupIsPending(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	o := fixture(t, db, "approved", nil)
	if _, err := db.Exec(ctx, `UPDATE server_requests SET recipe_id = 'docker', setup_status = 'pending' WHERE id = $1`, o.requestID); err != nil {
		t.Fatal(err)
	}
	provisionLeased(t, db, o.requestID)

	var buildMs *int
	var setupJobs int
	if err := db.QueryRow(ctx, `SELECT build_ms,
		(SELECT count(*) FROM provision_jobs WHERE request_id = $1 AND action = 'setup' AND status = 'queued')
		FROM server_requests WHERE id = $1`, o.requestID).Scan(&buildMs, &setupJobs); err != nil {
		t.Fatal(err)
	}
	if buildMs != nil || setupJobs != 1 {
		t.Fatalf("build_ms = %v, queued setup jobs = %d; want unset until setup is done, one setup job", buildMs, setupJobs)
	}
}
