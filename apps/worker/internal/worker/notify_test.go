package worker

import (
	"context"
	"testing"
	"time"
)

func waitForWake(t *testing.T, w *Worker, what string) {
	t.Helper()
	select {
	case <-w.wake:
	case <-time.After(10 * time.Second):
		t.Fatalf("no wake after %s", what)
	}
}

func TestQueuedJobInsertWakesIdleWorker(t *testing.T) {
	db := testDB(t)
	w := newTestWorker(db, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		w.listen(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	// Every LISTEN pokes once; consuming it proves the listener is subscribed.
	waitForWake(t, w, "connect")

	o := fixture(t, db, "approved", nil)
	if _, err := db.Exec(context.Background(),
		`INSERT INTO provision_jobs (request_id, action) VALUES ($1, 'provision')`, o.requestID); err != nil {
		t.Fatal(err)
	}
	waitForWake(t, w, "queued insert")
}
