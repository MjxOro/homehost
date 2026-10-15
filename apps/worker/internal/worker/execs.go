package worker

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// execsChannel is the NOTIFY channel apps/api/migrations/0020 fires for
// every queued machine_execs insert (docs/agent-access.md).
const execsChannel = "machine_execs"

const (
	// execQueueTTL fails rows no worker claimed in time; the waiting API
	// call gave up long before.
	execQueueTTL   = 10 * time.Minute
	execRetention  = 24 * time.Hour
	execPurgeEvery = time.Hour
)

// envScope matches server_requests r to Config.BaseDomain exactly like
// envMatches; $1 is the base domain, empty for every env.
const envScope = `($1::text = '' OR r.subdomain = $1::text
	OR right(r.subdomain, length($1::text) + 1) = '.' || $1::text)`

type execRow struct {
	id        string
	requestID string
	op        string
	command   *string
	cwd       *string
	path      *string
	input     []byte
	fileMode  *int
	maxBytes  int
	timeoutMs int
}

// execOutcome is what finishExec stores. errCode is a stable code, never
// guest output.
type execOutcome struct {
	exitCode        *int
	timedOut        bool
	stdout          []byte
	stderr          []byte
	stdoutTruncated bool
	stderrTruncated bool
	errCode         string
}

func failedExec(code string) execOutcome { return execOutcome{errCode: code} }

// pokeExec wakes one idle exec loop; a pending poke already covers this one.
func (w *Worker) pokeExec() {
	select {
	case w.execWake <- struct{}{}:
	default:
	}
}

func (w *Worker) idleExec(d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-w.stop:
	case <-w.execWake:
	}
}

// claimExec takes the oldest queued row of this worker's env:
// queued -> running. Rows are never re-queued, so an operation runs at most
// once.
func (w *Worker) claimExec(ctx context.Context) (*execRow, error) {
	var e execRow
	err := w.db.QueryRow(ctx, `
		UPDATE machine_execs e SET status = 'running', started_at = now()
		WHERE e.id = (
			SELECT q.id FROM machine_execs q
			JOIN server_requests r ON r.id = q.request_id
			WHERE q.status = 'queued' AND `+envScope+`
			ORDER BY q.created_at LIMIT 1
			FOR UPDATE OF q SKIP LOCKED
		)
		RETURNING e.id::text, e.request_id::text, e.op, e.command, e.cwd, e.path,
			e.input, e.file_mode, e.max_bytes, e.timeout_ms
	`, w.cfg.BaseDomain).Scan(&e.id, &e.requestID, &e.op, &e.command, &e.cwd, &e.path,
		&e.input, &e.fileMode, &e.maxBytes, &e.timeoutMs)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// finishExec stores the outcome and clears the write payload; the update
// trigger wakes the waiting API replica.
func (w *Worker) finishExec(ctx context.Context, id string, o execOutcome) error {
	status := "done"
	var errCode *string
	if o.errCode != "" {
		status = "failed"
		errCode = &o.errCode
	}
	_, err := w.db.Exec(ctx, `
		UPDATE machine_execs SET status = $2, exit_code = $3, timed_out = $4,
			stdout = $5, stderr = $6, stdout_truncated = $7, stderr_truncated = $8,
			error = $9, input = NULL, finished_at = now()
		WHERE id = $1 AND status = 'running'
	`, id, status, o.exitCode, o.timedOut, o.stdout, o.stderr, o.stdoutTruncated, o.stderrTruncated, errCode)
	return err
}

// recoverExecs fails what a previous process left behind: running rows died
// with it, and queued rows past their TTL have no caller waiting.
func (w *Worker) recoverExecs(ctx context.Context) (restarted, expired int64, err error) {
	tag, err := w.db.Exec(ctx, `
		UPDATE machine_execs e SET status = 'failed', error = 'worker_restarted',
			input = NULL, finished_at = now()
		FROM server_requests r
		WHERE r.id = e.request_id AND e.status = 'running' AND `+envScope,
		w.cfg.BaseDomain)
	if err != nil {
		return 0, 0, err
	}
	restarted = tag.RowsAffected()
	tag, err = w.db.Exec(ctx, `
		UPDATE machine_execs e SET status = 'failed', error = 'expired',
			input = NULL, finished_at = now()
		FROM server_requests r
		WHERE r.id = e.request_id AND e.status = 'queued'
			AND e.created_at < now() - make_interval(secs => $2) AND `+envScope,
		w.cfg.BaseDomain, execQueueTTL.Seconds())
	if err != nil {
		return restarted, 0, err
	}
	return restarted, tag.RowsAffected(), nil
}

func (w *Worker) purgeExecs(ctx context.Context) (int64, error) {
	tag, err := w.db.Exec(ctx, `
		DELETE FROM machine_execs
		WHERE finished_at < now() - make_interval(secs => $1)
	`, execRetention.Seconds())
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// runExecs drives ExecConcurrency claim loops plus the hourly purge until
// Shutdown, then returns once every in-flight operation has finished.
func (w *Worker) runExecs(ctx context.Context) {
	var wg sync.WaitGroup
	for range max(w.cfg.ExecConcurrency, 1) {
		wg.Go(func() {
			for !w.shuttingDown() {
				ran, err := w.runNextExec(ctx)
				if err != nil {
					w.log.Printf("exec loop error: %v", err)
					w.sleep(w.cfg.PollInterval)
					continue
				}
				if !ran {
					w.idleExec(w.cfg.PollInterval)
				}
			}
		})
	}
	wg.Go(func() {
		t := time.NewTicker(execPurgeEvery)
		defer t.Stop()
		for {
			select {
			case <-w.stop:
				return
			case <-t.C:
				if _, err := w.purgeExecs(ctx); err != nil {
					w.log.Printf("exec purge: %v", err)
				}
			}
		}
	})
	wg.Wait()
}

// runNextExec claims and runs one row; false means the queue was empty.
func (w *Worker) runNextExec(ctx context.Context) (bool, error) {
	row, err := w.claimExec(ctx)
	if err != nil || row == nil {
		return false, err
	}
	// More rows may be queued behind this one: let another idle loop look.
	w.pokeExec()
	return true, w.finishExec(ctx, row.id, w.runExec(ctx, row))
}

func (w *Worker) runExec(ctx context.Context, row *execRow) execOutcome {
	req, err := w.loadRequest(ctx, row.requestID)
	if err != nil {
		w.log.Printf("exec %s: load request: %v", row.id, err)
		return failedExec("exec_failed")
	}
	if req == nil || req.status != "running" || req.instanceName == nil {
		return failedExec("machine_not_running")
	}
	project, name := projectForReq(req), *req.instanceName
	timeout := time.Duration(row.timeoutMs) * time.Millisecond
	switch {
	case row.op == "command" && row.command != nil:
		cwd := ""
		if row.cwd != nil {
			cwd = *row.cwd
		}
		res := w.incus.Run(ctx, project, name, RunSpec{
			Argv:     []string{"/bin/sh", "-c", *row.command},
			Cwd:      cwd,
			Timeout:  timeout,
			MaxBytes: row.maxBytes,
		})
		if res.Err != nil && !res.TimedOut {
			w.log.Printf("exec %s: run failed on %s/%s", row.id, project, name)
			return failedExec("exec_failed")
		}
		return execOutcome{
			exitCode:        res.ExitCode,
			timedOut:        res.TimedOut,
			stdout:          res.Stdout,
			stderr:          res.Stderr,
			stdoutTruncated: res.StdoutTruncated,
			stderrTruncated: res.StderrTruncated,
		}
	case row.op == "read_file" && row.path != nil:
		opCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		data, truncated, err := w.incus.ReadFile(opCtx, project, name, *row.path, row.maxBytes)
		switch {
		case errors.Is(err, ErrNotFound):
			return failedExec("file_not_found")
		case errors.Is(err, ErrIsDirectory):
			return failedExec("is_directory")
		case err != nil:
			w.log.Printf("exec %s: read failed on %s/%s", row.id, project, name)
			return failedExec("exec_failed")
		}
		return execOutcome{stdout: data, stdoutTruncated: truncated}
	case row.op == "write_file" && row.path != nil:
		opCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		mode := 0
		if row.fileMode != nil {
			mode = *row.fileMode
		}
		if err := w.incus.WriteFile(opCtx, project, name, *row.path, row.input, mode); err != nil {
			w.log.Printf("exec %s: write failed on %s/%s", row.id, project, name)
			return failedExec("exec_failed")
		}
		return execOutcome{}
	default:
		return failedExec("exec_failed")
	}
}
