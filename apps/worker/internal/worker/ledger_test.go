package worker

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Integration tests against the real schema (apps/api/migrations) in a
// throwaway Postgres schema. Skipped without TEST_DATABASE_URL.

const (
	testAddress = "2001:db8:abcd::a"
	testStart   = "2026-10-02T14:00:00.000Z"
	testEnd     = "2026-10-02T15:00:00.000Z"
)

func uuid() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func testDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL unset")
	}
	ctx := context.Background()
	schema := "test_" + strings.ReplaceAll(uuid(), "-", "")
	admin, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
		_ = admin.Close(context.Background())
	})
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.MaxConns = 8
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	files, err := filepath.Glob("../../../api/migrations/*.sql")
	if err != nil || len(files) == 0 {
		t.Fatalf("migrations not found: %v", err)
	}
	sort.Strings(files)
	for _, file := range files {
		source, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(source)); err != nil {
			t.Fatalf("%s: %v", filepath.Base(file), err)
		}
	}
	return pool
}

type owner struct {
	userID, requestID, ownerName, ownerEmail, subdomain string
}

func fixture(t *testing.T, db *pgxpool.Pool, status string, ipv6 *string) owner {
	t.Helper()
	o := owner{userID: uuid(), requestID: uuid()}
	o.ownerName = "Owner " + o.userID[:8]
	o.ownerEmail = o.userID + "@example.test"
	o.subdomain = "ip-" + o.requestID + ".lab.example.test"
	ctx := context.Background()
	if _, err := db.Exec(ctx, `INSERT INTO users (id, name, email, role, tier)
		VALUES ($1, $2, $3, 'member', 'nontechnical')`, o.userID, o.ownerName, o.ownerEmail); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO server_requests
		(id, owner_id, owner_name, name, plan_id, status, subdomain, cpu, memory_mb, disk_gb, ipv6, created_at, updated_at)
		VALUES ($1, $2, $3, 'History fixture', 'container-small', $4, $5, 1, 512, 10, $6, $7, $8)`,
		o.requestID, o.userID, o.ownerName, status, o.subdomain, ipv6, testStart, testEnd); err != nil {
		t.Fatal(err)
	}
	return o
}

func assign(t *testing.T, db *pgxpool.Pool, o owner, ip string) {
	t.Helper()
	if _, err := db.Exec(context.Background(), `INSERT INTO ip_assignments
		(request_id, user_id, owner_name, owner_email, address, subdomain, prefix, assigned_at)
		VALUES ($1, $2, $3, $4, $5::inet, $6, network(set_masklen($5::inet, 64))::text, $7)`,
		o.requestID, o.userID, o.ownerName, o.ownerEmail, ip, o.subdomain, testStart); err != nil {
		t.Fatal(err)
	}
}

type assignment struct {
	id, requestID, userID, ownerEmail, prefix string
	assignedAt                                time.Time
	releasedAt                                *time.Time
}

// assignments lists the history of ip (equivalent spellings match), newest first.
func assignments(t *testing.T, db *pgxpool.Pool, ip string) []assignment {
	t.Helper()
	rows, err := db.Query(context.Background(), `
		SELECT id::text, request_id::text, user_id, owner_email, prefix, assigned_at, released_at
		FROM ip_assignments WHERE address = $1::inet ORDER BY assigned_at DESC, id`, ip)
	if err != nil {
		t.Fatal(err)
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (assignment, error) {
		var a assignment
		err := row.Scan(&a.id, &a.requestID, &a.userID, &a.ownerEmail, &a.prefix, &a.assignedAt, &a.releasedAt)
		return a, err
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func requestIpv6(t *testing.T, db *pgxpool.Pool, requestID string) *string {
	t.Helper()
	var ipv6 *string
	if err := db.QueryRow(context.Background(), `SELECT ipv6 FROM server_requests WHERE id = $1`, requestID).Scan(&ipv6); err != nil {
		t.Fatal(err)
	}
	return ipv6
}

func newTestWorker(db *pgxpool.Pool, incus Incus, dns DNS) *Worker {
	return New(Config{TeardownAttempts: 25, RoutesDir: os.TempDir()}, db, incus, dns, log.New(io.Discard, "", 0))
}

func TestSetIpv6ConcurrentRetriesKeepFirstSnapshot(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	w := newTestWorker(db, nil, nil)
	o := fixture(t, db, "running", nil)
	if err := w.setIpv6(ctx, o.requestID, testAddress); err != nil {
		t.Fatal(err)
	}
	original := assignments(t, db, testAddress)[0]
	if _, err := db.Exec(ctx, `UPDATE users SET email = $1 WHERE id = $2`, uuid()+"@example.test", o.userID); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i, ip := range []string{testAddress, "2001:0DB8:ABCD:0:0:0:0:A"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = w.setIpv6(ctx, o.requestID, ip)
		}()
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		t.Fatal(err)
	}
	rows := assignments(t, db, testAddress)
	if len(rows) != 1 || rows[0].id != original.id || !rows[0].assignedAt.Equal(original.assignedAt) || rows[0].ownerEmail != o.ownerEmail {
		t.Fatalf("snapshot changed: %+v, original %+v", rows, original)
	}
	if requestIpv6(t, db, o.requestID) == nil {
		t.Fatal("request ipv6 not stored")
	}
}

func TestSetIpv6CollisionRollsBack(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	w := newTestWorker(db, nil, nil)
	first := fixture(t, db, "running", nil)
	second := fixture(t, db, "running", nil)
	if err := w.setIpv6(ctx, first.requestID, testAddress); err != nil {
		t.Fatal(err)
	}
	if err := w.setIpv6(ctx, second.requestID, "2001:db8:abcd::b"); err != nil {
		t.Fatal(err)
	}
	if err := w.setIpv6(ctx, second.requestID, testAddress); !errors.Is(err, errIpv6Taken) {
		t.Fatalf("collision error = %v", err)
	}
	if got := requestIpv6(t, db, second.requestID); got == nil || *got != "2001:db8:abcd::b" {
		t.Fatalf("second request ipv6 = %v, want rollback to ::b", got)
	}
	if rows := assignments(t, db, "2001:db8:abcd::b"); rows[0].releasedAt != nil {
		t.Fatal("rotation of the second request was not rolled back")
	}
	if rows := assignments(t, db, testAddress); rows[0].userID != first.userID {
		t.Fatal("address changed owner")
	}
}

func TestSetIpv6RotationClosesOldAddress(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	w := newTestWorker(db, nil, nil)
	o := fixture(t, db, "running", nil)
	if err := w.setIpv6(ctx, o.requestID, testAddress); err != nil {
		t.Fatal(err)
	}
	if err := w.setIpv6(ctx, o.requestID, "2001:db8:ffff::a"); err != nil {
		t.Fatal(err)
	}
	if assignments(t, db, testAddress)[0].releasedAt == nil {
		t.Fatal("old address still open")
	}
	if got := assignments(t, db, "2001:db8:ffff::a")[0].prefix; got != "2001:db8:ffff::/64" {
		t.Fatalf("prefix = %q", got)
	}
}

func TestReconcileInsertsMissingAssignmentsOnce(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	w := newTestWorker(db, nil, nil)
	live := fixture(t, db, "running", new(testAddress))
	parked := fixture(t, db, "approved", new("2001:db8:abcd::d"))
	covered := fixture(t, db, "running", new("2001:db8:abcd::e"))
	assign(t, db, covered, "2001:db8:abcd::e")
	holder := fixture(t, db, "running", nil)
	assign(t, db, holder, "2001:db8:abcd::f")
	fixture(t, db, "running", new("2001:db8:abcd::f"))
	fixture(t, db, "deleted", new("2001:db8:abcd::b"))
	fixture(t, db, "rejected", new("2001:db8:abcd::c"))
	fixture(t, db, "running", nil)
	fixture(t, db, "running", new("not-an-ip"))
	for _, want := range []int64{2, 0} {
		got, err := w.reconcileIpv6Assignments(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("reconcile inserted %d, want %d", got, want)
		}
	}
	inserted := assignments(t, db, testAddress)
	if len(inserted) != 1 || inserted[0].ownerEmail != live.ownerEmail || inserted[0].releasedAt != nil ||
		inserted[0].assignedAt.UTC().Format("2006-01-02T15:04:05.000Z") != testStart {
		t.Fatalf("live assignment = %+v", inserted)
	}
	if rows := assignments(t, db, "2001:db8:abcd::d"); len(rows) != 1 || rows[0].requestID != parked.requestID {
		t.Fatalf("parked request not reconciled: %+v", rows)
	}
}

// fakeIncus scripts Delete/Exists outcomes for teardown.
type fakeIncus struct {
	Incus
	t         *testing.T
	wantName  string
	deleteErr error
	exists    bool
	existsErr error
	events    *[]string
}

func (f *fakeIncus) Delete(_ context.Context, _, name string) error {
	*f.events = append(*f.events, "delete")
	if name != f.wantName {
		f.t.Errorf("delete %q, want %q", name, f.wantName)
	}
	return f.deleteErr
}

func (f *fakeIncus) Exists(_ context.Context, _, name string) (bool, error) {
	*f.events = append(*f.events, "exists")
	return f.exists, f.existsErr
}

// fakeDNS asserts the address history is already closed when DNS cleanup runs.
type fakeDNS struct {
	DNS
	t      *testing.T
	db     *pgxpool.Pool
	ip     string
	err    error
	events *[]string
}

func (f *fakeDNS) DeleteAAAA(context.Context, string) error {
	*f.events = append(*f.events, "dns")
	if rows := assignments(f.t, f.db, f.ip); len(rows) == 0 || rows[0].releasedAt == nil {
		f.t.Error("DNS cleanup ran before the assignment was released")
	}
	return f.err
}

func jobStatus(t *testing.T, db *pgxpool.Pool, id string) string {
	t.Helper()
	var status string
	if err := db.QueryRow(context.Background(), `SELECT status FROM provision_jobs WHERE id = $1`, id).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

func leasedTeardown(t *testing.T, db *pgxpool.Pool, requestID string, attempts int) *job {
	t.Helper()
	j := &job{requestID: requestID, action: "teardown", attempts: attempts}
	if err := db.QueryRow(context.Background(), `INSERT INTO provision_jobs (request_id, action, status, attempts)
		VALUES ($1, 'teardown', 'leased', $2) RETURNING id::text`, requestID, attempts).Scan(&j.id); err != nil {
		t.Fatal(err)
	}
	return j
}

func TestTeardownReleasesHistoryOnlyOnceInstanceIsGone(t *testing.T) {
	daemonDown := errors.New("cannot connect to daemon")
	cases := []struct {
		name         string
		storedName   bool
		deleteErr    error
		exists       bool
		existsErr    error
		ledgerFails  bool
		dnsErr       error
		attempts     int
		wantEvents   []string
		wantStatus   string
		wantReleased bool
	}{
		{name: "deleted", storedName: true, wantEvents: []string{"delete", "dns"}, wantStatus: "done", wantReleased: true},
		{name: "instance not found", storedName: true, deleteErr: fmt.Errorf("incus delete: %w", ErrNotFound),
			wantEvents: []string{"delete", "dns"}, wantStatus: "done", wantReleased: true},
		{name: "already gone, derived name", deleteErr: daemonDown,
			wantEvents: []string{"delete", "exists", "dns"}, wantStatus: "done", wantReleased: true},
		{name: "still present", storedName: true, deleteErr: daemonDown, exists: true,
			wantEvents: []string{"delete", "exists"}, wantStatus: "queued"},
		{name: "existence check fails", storedName: true, deleteErr: daemonDown, existsErr: daemonDown,
			wantEvents: []string{"delete", "exists"}, wantStatus: "queued"},
		{name: "ledger fails", storedName: true, ledgerFails: true,
			wantEvents: []string{"delete"}, wantStatus: "queued"},
		{name: "dns fails after release", storedName: true, dnsErr: errors.New("DNS unavailable"),
			wantEvents: []string{"delete", "dns"}, wantStatus: "queued", wantReleased: true},
		{name: "dns fails on last attempt", storedName: true, dnsErr: errors.New("DNS unavailable"), attempts: 25,
			wantEvents: []string{"delete", "dns"}, wantStatus: "failed", wantReleased: true},
	}
	db := testDB(t)
	ctx := context.Background()
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Distinct addresses: each case owns one open assignment.
			ip := fmt.Sprintf("2001:db8:abcd::%x", 0x100+i)
			o := fixture(t, db, "running", nil)
			wantName := instanceNameOf(o.requestID, o.subdomain)
			if tc.storedName {
				wantName = "req-stored-" + o.requestID
				if _, err := db.Exec(ctx, `UPDATE server_requests SET instance_name = $1 WHERE id = $2`, wantName, o.requestID); err != nil {
					t.Fatal(err)
				}
			}
			var events []string
			w := newTestWorker(db,
				&fakeIncus{t: t, wantName: wantName, deleteErr: tc.deleteErr, exists: tc.exists, existsErr: tc.existsErr, events: &events},
				&fakeDNS{t: t, db: db, ip: ip, err: tc.dnsErr, events: &events})
			if err := w.setIpv6(ctx, o.requestID, ip); err != nil {
				t.Fatal(err)
			}
			if tc.ledgerFails {
				if _, err := db.Exec(ctx, `
					CREATE FUNCTION ledger_down() RETURNS trigger LANGUAGE plpgsql AS $$
					BEGIN RAISE EXCEPTION 'ledger unavailable'; END $$;
					CREATE TRIGGER ledger_down BEFORE UPDATE ON ip_assignments
					FOR EACH ROW EXECUTE FUNCTION ledger_down();`); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					_, _ = db.Exec(ctx, `DROP TRIGGER ledger_down ON ip_assignments; DROP FUNCTION ledger_down();`)
				})
			}
			attempts := max(tc.attempts, 1)
			j := leasedTeardown(t, db, o.requestID, attempts)
			if err := w.handleTeardown(ctx, j); err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(events, tc.wantEvents) {
				t.Errorf("events = %v, want %v", events, tc.wantEvents)
			}
			if got := jobStatus(t, db, j.id); got != tc.wantStatus {
				t.Errorf("job status = %s, want %s", got, tc.wantStatus)
			}
			if released := assignments(t, db, ip)[0].releasedAt != nil; released != tc.wantReleased {
				t.Errorf("released = %v, want %v", released, tc.wantReleased)
			}
		})
	}
}

func TestTeardownReleaseIsIdempotentAndAddressReusable(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	o := fixture(t, db, "running", nil)
	var events []string
	w := newTestWorker(db,
		&fakeIncus{t: t, wantName: instanceNameOf(o.requestID, o.subdomain), events: &events},
		&fakeDNS{t: t, db: db, ip: testAddress, events: &events})
	if err := w.setIpv6(ctx, o.requestID, testAddress); err != nil {
		t.Fatal(err)
	}
	if err := w.handleTeardown(ctx, leasedTeardown(t, db, o.requestID, 1)); err != nil {
		t.Fatal(err)
	}
	releasedAt := assignments(t, db, testAddress)[0].releasedAt
	if err := w.releaseIpv6(ctx, o.requestID); err != nil {
		t.Fatal(err)
	}
	if again := assignments(t, db, testAddress)[0].releasedAt; again == nil || !again.Equal(*releasedAt) {
		t.Fatalf("second release moved released_at: %v -> %v", releasedAt, again)
	}
	if err := w.setIpv6(ctx, o.requestID, testAddress); err != nil {
		t.Fatal(err)
	}
	rows := assignments(t, db, testAddress)
	if len(rows) != 2 || rows[0].releasedAt != nil {
		t.Fatalf("reassignment = %+v", rows)
	}
}

func TestTeardownOfPurgedRequestReleasesAssignment(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	o := fixture(t, db, "running", nil)
	w := newTestWorker(db, nil, nil)
	if err := w.setIpv6(ctx, o.requestID, testAddress); err != nil {
		t.Fatal(err)
	}
	// History has no foreign keys: it survives the request's deletion.
	if _, err := db.Exec(ctx, `DELETE FROM server_requests WHERE id = $1`, o.requestID); err != nil {
		t.Fatal(err)
	}
	if err := w.handleTeardown(ctx, &job{id: uuid(), requestID: o.requestID, action: "teardown", attempts: 1}); err != nil {
		t.Fatal(err)
	}
	if assignments(t, db, testAddress)[0].releasedAt == nil {
		t.Fatal("purged request's assignment still open")
	}
}
