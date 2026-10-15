package worker

import (
	"bytes"
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// execIncus scripts Run/ReadFile/WriteFile and records what the worker asked.
type execIncus struct {
	Incus
	runs    []RunSpec
	project string
	name    string
	run     RunResult
	read    []byte
	readErr error
	written []byte
	mode    int
}

func (f *execIncus) Run(_ context.Context, project, name string, spec RunSpec) RunResult {
	f.project, f.name = project, name
	f.runs = append(f.runs, spec)
	return f.run
}

func (f *execIncus) ReadFile(_ context.Context, project, name, _ string, maxBytes int) ([]byte, bool, error) {
	f.project, f.name = project, name
	if f.readErr != nil {
		return nil, false, f.readErr
	}
	if len(f.read) > maxBytes {
		return f.read[:maxBytes], true, nil
	}
	return f.read, false, nil
}

func (f *execIncus) WriteFile(_ context.Context, project, name, _ string, content []byte, mode int) error {
	f.project, f.name = project, name
	f.written, f.mode = content, mode
	return nil
}

func runningMachine(t *testing.T, db *pgxpool.Pool) owner {
	t.Helper()
	o := fixture(t, db, "running", nil)
	if _, err := db.Exec(context.Background(),
		`UPDATE server_requests SET instance_name = $2 WHERE id = $1`,
		o.requestID, "req-"+o.requestID[:8]); err != nil {
		t.Fatal(err)
	}
	return o
}

func queueExec(t *testing.T, db *pgxpool.Pool, o owner, op, target string, input []byte, maxBytes int) string {
	t.Helper()
	var command, path *string
	if op == "command" {
		command = &target
	} else {
		path = &target
	}
	var id string
	if err := db.QueryRow(context.Background(), `
		INSERT INTO machine_execs (request_id, user_id, op, command, path, input, file_mode, max_bytes, timeout_ms)
		VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $3 = 'write_file' THEN 384 END, $7, 5000)
		RETURNING id::text`,
		o.requestID, o.userID, op, command, path, input, maxBytes).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

type finishedExec struct {
	status          string
	exitCode        *int
	stdout          []byte
	stdoutTruncated bool
	errCode         *string
	inputCleared    bool
}

func execResult(t *testing.T, db *pgxpool.Pool, id string) finishedExec {
	t.Helper()
	var f finishedExec
	if err := db.QueryRow(context.Background(), `
		SELECT status, exit_code, stdout, stdout_truncated, error, input IS NULL
		FROM machine_execs WHERE id = $1`, id).
		Scan(&f.status, &f.exitCode, &f.stdout, &f.stdoutTruncated, &f.errCode, &f.inputCleared); err != nil {
		t.Fatal(err)
	}
	return f
}

func runOne(t *testing.T, w *Worker) {
	t.Helper()
	ran, err := w.runNextExec(context.Background())
	if err != nil || !ran {
		t.Fatalf("runNextExec = %v, %v; want one row run", ran, err)
	}
}

func TestExecRunsCommandsAndFilesOnce(t *testing.T) {
	db := testDB(t)
	exit := 3
	fake := &execIncus{
		run:  RunResult{ExitCode: &exit, Stdout: []byte("out"), Stderr: []byte("err")},
		read: []byte("0123456789"),
	}
	w := newTestWorker(db, fake, nil)
	o := runningMachine(t, db)

	cmd := queueExec(t, db, o, "command", "echo hi", nil, 4096)
	runOne(t, w)
	if got := execResult(t, db, cmd); got.status != "done" || got.exitCode == nil || *got.exitCode != 3 || string(got.stdout) != "out" {
		t.Fatalf("command row = %+v", got)
	}
	spec := fake.runs[0]
	if fmt.Sprint(spec.Argv) != "[/bin/sh -c echo hi]" || spec.MaxBytes != 4096 || spec.Timeout.Milliseconds() != 5000 {
		t.Fatalf("run spec = %+v", spec)
	}
	if fake.project != "tenant-"+o.userID || fake.name != "req-"+o.requestID[:8] {
		t.Fatalf("ran on %s/%s", fake.project, fake.name)
	}

	read := queueExec(t, db, o, "read_file", "/etc/hostname", nil, 4)
	runOne(t, w)
	if got := execResult(t, db, read); got.status != "done" || string(got.stdout) != "0123" || !got.stdoutTruncated {
		t.Fatalf("read row = %+v", got)
	}

	write := queueExec(t, db, o, "write_file", "/root/x", []byte("payload"), 7)
	runOne(t, w)
	if got := execResult(t, db, write); got.status != "done" || !got.inputCleared {
		t.Fatalf("write row = %+v", got)
	}
	if !bytes.Equal(fake.written, []byte("payload")) || fake.mode != 0o600 {
		t.Fatalf("wrote %q mode %o", fake.written, fake.mode)
	}

	if ran, err := w.runNextExec(context.Background()); ran || err != nil {
		t.Fatalf("finished rows were claimed again: %v, %v", ran, err)
	}
}

func TestExecFailuresUseStableCodes(t *testing.T) {
	db := testDB(t)
	fake := &execIncus{}
	w := newTestWorker(db, fake, nil)
	o := runningMachine(t, db)

	for _, tc := range []struct {
		err  error
		code string
	}{
		{fmt.Errorf("incus read: %w", ErrNotFound), "file_not_found"},
		{fmt.Errorf("incus read: %w", ErrIsDirectory), "is_directory"},
		{fmt.Errorf("socket closed"), "exec_failed"},
	} {
		fake.readErr = tc.err
		id := queueExec(t, db, o, "read_file", "/x", nil, 10)
		runOne(t, w)
		if got := execResult(t, db, id); got.status != "failed" || got.errCode == nil || *got.errCode != tc.code {
			t.Fatalf("%v: row = %+v, want %s", tc.err, got, tc.code)
		}
	}

	stopped := fixture(t, db, "stopped", nil)
	id := queueExec(t, db, stopped, "command", "true", nil, 10)
	runOne(t, w)
	if got := execResult(t, db, id); got.errCode == nil || *got.errCode != "machine_not_running" {
		t.Fatalf("stopped machine row = %+v", got)
	}
	if len(fake.runs) != 0 {
		t.Fatalf("command ran on a stopped machine")
	}
}

func TestExecClaimIsEnvScoped(t *testing.T) {
	db := testDB(t)
	w := newTestWorker(db, &execIncus{}, nil)
	w.cfg.BaseDomain = "other.example.test"
	o := runningMachine(t, db)
	id := queueExec(t, db, o, "command", "true", nil, 10)
	if ran, err := w.runNextExec(context.Background()); ran || err != nil {
		t.Fatalf("other-env row claimed: %v, %v", ran, err)
	}
	w.cfg.BaseDomain = "lab.example.test"
	runOne(t, w)
	if got := execResult(t, db, id); got.status != "done" {
		t.Fatalf("own-env row = %+v", got)
	}
}

func TestExecRecoveryAndPurge(t *testing.T) {
	db := testDB(t)
	w := newTestWorker(db, &execIncus{}, nil)
	o := runningMachine(t, db)
	ctx := context.Background()
	running := queueExec(t, db, o, "command", "sleep 9", nil, 10)
	stale := queueExec(t, db, o, "command", "true", nil, 10)
	fresh := queueExec(t, db, o, "command", "true", nil, 10)
	old := queueExec(t, db, o, "command", "true", nil, 10)
	if _, err := db.Exec(ctx, `UPDATE machine_execs SET status = 'running' WHERE id = $1`, running); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE machine_execs SET created_at = now() - interval '11 minutes' WHERE id = $1`, stale); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE machine_execs SET status = 'done', finished_at = now() - interval '25 hours' WHERE id = $1`, old); err != nil {
		t.Fatal(err)
	}

	restarted, expired, err := w.recoverExecs(ctx)
	if err != nil || restarted != 1 || expired != 1 {
		t.Fatalf("recoverExecs = %d, %d, %v", restarted, expired, err)
	}
	if got := execResult(t, db, running); got.errCode == nil || *got.errCode != "worker_restarted" {
		t.Fatalf("running row = %+v", got)
	}
	if got := execResult(t, db, stale); got.errCode == nil || *got.errCode != "expired" {
		t.Fatalf("stale row = %+v", got)
	}
	if got := execResult(t, db, fresh); got.status != "queued" {
		t.Fatalf("fresh row = %+v", got)
	}
	purged, err := w.purgeExecs(ctx)
	if err != nil || purged != 1 {
		t.Fatalf("purgeExecs = %d, %v", purged, err)
	}
}

func TestQueuedExecInsertWakesExecLoop(t *testing.T) {
	db := testDB(t)
	w := newTestWorker(db, nil, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	done := make(chan struct{})
	go func() {
		defer close(done)
		w.listen(ctx, execsChannel, w.pokeExec)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	waitForExecWake := func(what string) {
		t.Helper()
		select {
		case <-w.execWake:
		case <-ctx.Done():
			t.Fatalf("no exec wake after %s", what)
		}
	}
	// Every LISTEN pokes once; consuming it proves the listener is subscribed.
	waitForExecWake("connect")
	queueExec(t, db, runningMachine(t, db), "command", "true", nil, 10)
	waitForExecWake("queued insert")
}
