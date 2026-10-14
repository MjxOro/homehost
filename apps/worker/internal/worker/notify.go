package worker

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// jobsChannel is the NOTIFY channel apps/api/migrations/0017 fires for
// every queued provision_jobs insert.
const jobsChannel = "provision_jobs"

const maxListenBackoff = 30 * time.Second

// poke wakes an idle loop; a pending poke already covers this one.
func (w *Worker) poke() {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

// listen LISTENs on channel over a dedicated connection (pool connections
// are borrowed per query and cannot hold a LISTEN) and calls poke on every
// notification until ctx ends, reconnecting with capped backoff.
func (w *Worker) listen(ctx context.Context, channel string, poke func()) {
	backoff := time.Second
	for {
		err := w.listenOnce(ctx, channel, poke, func() { backoff = time.Second })
		if ctx.Err() != nil {
			return
		}
		w.log.Printf("%s listener: %v (reconnecting in %s)", channel, err, backoff)
		t := time.NewTimer(backoff)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			return
		}
		backoff = min(backoff*2, maxListenBackoff)
	}
}

// listenOnce runs one connection's lifetime. Every successful LISTEN pokes
// once: inserts made while disconnected sent notifications nobody heard.
func (w *Worker) listenOnce(ctx context.Context, channel string, poke, connected func()) error {
	conn, err := pgx.ConnectConfig(ctx, w.db.Config().ConnConfig.Copy())
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(ctx, "LISTEN "+channel); err != nil {
		return err
	}
	connected()
	poke()
	for {
		if _, err := conn.WaitForNotification(ctx); err != nil {
			return err
		}
		poke()
	}
}
