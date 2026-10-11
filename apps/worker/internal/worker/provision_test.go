package worker

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"testing"
)

// imageMissingIncus fails every launch the way internal/incus does when the
// plan's baked image was never built.
type imageMissingIncus struct {
	Incus
}

func (imageMissingIncus) EnsureProject(context.Context, string) error { return nil }

func (imageMissingIncus) Delete(context.Context, string, string) error { return ErrNotFound }

func (imageMissingIncus) Launch(_ context.Context, _, name string, spec LaunchSpec) error {
	return fmt.Errorf("incus launch %s: image %s missing: %w", name, spec.Image, ErrImageMissing)
}

func TestProvisionFailsAtOnceWhenBakedImageMissing(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	o := fixture(t, db, "approved", nil)
	w := New(Config{ProvisionAttempts: 5, RoutesDir: os.TempDir()}, db, imageMissingIncus{}, nil, log.New(io.Discard, "", 0))
	j := &job{requestID: o.requestID, action: "provision", attempts: 1}
	if err := db.QueryRow(ctx, `INSERT INTO provision_jobs (request_id, action, status, attempts)
		VALUES ($1, 'provision', 'leased', 1) RETURNING id::text`, o.requestID).Scan(&j.id); err != nil {
		t.Fatal(err)
	}
	if err := w.handleProvision(ctx, j); err != nil {
		t.Fatal(err)
	}
	var status, lastError, requestStatus string
	if err := db.QueryRow(ctx, `SELECT status, last_error FROM provision_jobs WHERE id = $1`, j.id).Scan(&status, &lastError); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || !strings.Contains(lastError, "homehost/ubuntu-24.04/container missing") {
		t.Fatalf("job = %s %q, want failed on the first attempt naming the image", status, lastError)
	}
	if err := db.QueryRow(ctx, `SELECT status FROM server_requests WHERE id = $1`, o.requestID).Scan(&requestStatus); err != nil {
		t.Fatal(err)
	}
	if requestStatus != "approved" {
		t.Fatalf("request status = %s, want approved", requestStatus)
	}
}
