// Package worker is the host-side provisioning loop: it leases
// provision_jobs from Postgres and drives Incus, Cloudflare DNS and IPv6
// assignment for each tenant box.
package worker

import (
	"context"
	"errors"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Config is the worker's environment-derived tuning.
type Config struct {
	PollInterval      time.Duration
	ProvisionAttempts int
	TeardownAttempts  int
	PowerAttempts     int
	// SetupAttempts caps job leases of one setup: a worker crash re-leases
	// it, a crash loop stops here.
	SetupAttempts int
	BootTimeout   time.Duration
	ReadyTimeout  time.Duration
	// IPv6Prefix is the routed /64 tenant addresses come from; empty on
	// v4-only hosts.
	IPv6Prefix string
	// Env labels the boot log line ("prod", "dev").
	Env string
	// BaseDomain, when set, scopes the worker to requests whose subdomain
	// sits under it; other-env jobs are requeued untouched.
	BaseDomain string
	// RoutesDir receives per-desktop-VM Traefik route files.
	RoutesDir string
	// ExecConcurrency is how many agent operations (machine_execs) run at
	// once, beside the serial provisioning loop.
	ExecConcurrency int
}

// Worker runs jobs one at a time.
type Worker struct {
	cfg   Config
	db    *pgxpool.Pool
	incus Incus
	// dns is nil without a Cloudflare token: AAAA records and the public
	// DNS readiness check are skipped.
	dns DNS
	log *log.Logger

	stopOnce sync.Once
	stop     chan struct{}
	// wake ends an idle wait early: the job listener pokes it on every
	// provision_jobs notification.
	wake chan struct{}
	// execWake ends an exec loop's idle wait on a machine_execs notification.
	execWake chan struct{}
	// probeTCP reports whether host:port accepts a connection.
	probeTCP func(ctx context.Context, host string, port int) bool
}

func New(cfg Config, db *pgxpool.Pool, incus Incus, dns DNS, logger *log.Logger) *Worker {
	return &Worker{
		cfg:      cfg,
		db:       db,
		incus:    incus,
		dns:      dns,
		log:      logger,
		stop:     make(chan struct{}),
		wake:     make(chan struct{}, 1),
		execWake: make(chan struct{}, 1),
		probeTCP: tcpConnects,
	}
}

// Shutdown asks the loop to exit after the current job. Safe to call twice.
func (w *Worker) Shutdown() {
	w.stopOnce.Do(func() { close(w.stop) })
}

func (w *Worker) shuttingDown() bool {
	select {
	case <-w.stop:
		return true
	default:
		return false
	}
}

// sleep waits d, returning early on shutdown.
func (w *Worker) sleep(d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-w.stop:
	}
}

// idle waits up to d for new work: a job notification or shutdown ends it
// early. The poll interval stays the safety net for missed notifications.
func (w *Worker) idle(d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-w.stop:
	case <-w.wake:
	}
}

// Run recovers state from a previous process, then takes jobs as they are
// notified (polling as the fallback) until Shutdown. Jobs run on a
// background context: a stop request lets the current job reach its own
// shutdown checks instead of aborting mid-write.
func (w *Worker) Run() error {
	ctx := context.Background()
	listenCtx, stopListening := context.WithCancel(ctx)
	listening := make(chan struct{})
	go func() {
		defer close(listening)
		var listeners sync.WaitGroup
		listeners.Go(func() { w.listen(listenCtx, jobsChannel, w.poke) })
		listeners.Go(func() { w.listen(listenCtx, execsChannel, w.pokeExec) })
		listeners.Wait()
	}()
	defer func() {
		stopListening()
		<-listening
	}()
	// Crash recovery: leases die with the process; requeue so jobs resume.
	// Instance names make relaunches idempotent.
	if err := w.requeueLeased(ctx); err != nil {
		return err
	}
	reconciled, err := w.reconcileIpv6Assignments(ctx)
	if err != nil {
		return err
	}
	w.log.Printf("ip_assignments reconcile: inserted %d row(s)", reconciled)
	restarted, expired, err := w.recoverExecs(ctx)
	if err != nil {
		return err
	}
	purged, err := w.purgeExecs(ctx)
	if err != nil {
		return err
	}
	w.log.Printf("machine_execs recovery: %d restarted, %d expired, %d purged", restarted, expired, purged)
	execs := make(chan struct{})
	go func() {
		defer close(execs)
		w.runExecs(ctx)
	}()
	w.log.Printf("worker up (%s): listening + polling provision_jobs", w.cfg.Env)
	for !w.shuttingDown() {
		if err := w.tick(ctx); err != nil {
			w.log.Printf("worker loop error: %v", err)
			w.sleep(w.cfg.PollInterval)
		}
	}
	<-execs
	w.log.Print("worker down")
	return nil
}

func (w *Worker) tick(ctx context.Context) error {
	j, err := w.leaseJob(ctx)
	if err != nil {
		return err
	}
	if j == nil {
		w.idle(w.cfg.PollInterval)
		return nil
	}
	// Env scoping: leave other-env jobs queued for their own worker. No
	// Incus/DB request state touched — just requeue the lease.
	req, err := w.loadRequest(ctx, j.requestID)
	if err != nil {
		return err
	}
	if req != nil && !w.envMatches(req.subdomain) {
		if err := w.requeue(ctx, j.id, "wrong-env:"+req.subdomain); err != nil {
			return err
		}
		w.sleep(w.cfg.PollInterval)
		return nil
	}
	return w.handle(ctx, j)
}

func (w *Worker) envMatches(subdomain string) bool {
	if w.cfg.BaseDomain == "" {
		return true
	}
	return subdomain == w.cfg.BaseDomain || strings.HasSuffix(subdomain, "."+w.cfg.BaseDomain)
}

// Env placement: dev rows (subdomain under dev.homehost.risktozero.sh, the
// dev BASE_DOMAIN in .env.dev) live in tenant-dev-* projects; prod and
// showcase rows keep the legacy tenant-* placement so existing VMs never
// move. Derived from the request's own subdomain so every worker agrees
// regardless of its BaseDomain filter.
func isDevSubdomain(subdomain string) bool {
	return strings.HasSuffix(subdomain, ".dev.homehost.risktozero.sh")
}

func projectOf(ownerID, subdomain string) string {
	if isDevSubdomain(subdomain) {
		return "tenant-dev-" + ownerID
	}
	return "tenant-" + ownerID
}

// projectForReq is the project holding this request's instance. Stored
// dev-req-* names live in the dev project; stored legacy names (prod rows
// plus pre-split dev VMs like tenant-operator/req-1828ca5e) stay in the
// legacy project; fresh rows derive from their subdomain. Teardown and
// power must use this, never projectOf, or pre-split dev VMs become orphans.
func projectForReq(r *request) string {
	if r.instanceName != nil && strings.HasPrefix(*r.instanceName, "dev-req-") {
		return "tenant-dev-" + r.ownerID
	}
	if r.instanceName != nil {
		return "tenant-" + r.ownerID
	}
	return projectOf(r.ownerID, r.subdomain)
}

// instanceNameOf derives the instance name from the request id, so
// relaunches are idempotent. Dev VMs carry the env in the name (visible in
// `incus list` across projects); prod/showcase keep the legacy req-* shape.
func instanceNameOf(requestID, subdomain string) string {
	short := strings.ReplaceAll(requestID, "-", "")
	if len(short) > 8 {
		short = short[:8]
	}
	if isDevSubdomain(subdomain) {
		return "dev-req-" + short
	}
	return "req-" + short
}

func tcpConnects(ctx context.Context, host string, port int) bool {
	d := net.Dialer{Timeout: 3 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// readinessCheck is one condition of a readiness gate.
type readinessCheck struct {
	// failure is reported when the check never passed.
	failure string
	run     func(ctx context.Context) (bool, error)
}

// pollChecks runs every check each round until all have passed. A passed
// check is not re-run; an erroring check counts as not passed. At least one
// round always runs; past the deadline it fails naming only the checks
// still failing.
func pollChecks(ctx context.Context, checks []readinessCheck, timeout, interval time.Duration) error {
	deadline := time.Now().Add(timeout)
	pending := checks
	for {
		ok := make([]bool, len(pending))
		var wg sync.WaitGroup
		for i, check := range pending {
			wg.Add(1)
			go func() {
				defer wg.Done()
				passed, err := check.run(ctx)
				ok[i] = err == nil && passed
			}()
		}
		wg.Wait()
		var still []readinessCheck
		for i, check := range pending {
			if !ok[i] {
				still = append(still, check)
			}
		}
		pending = still
		if len(pending) == 0 {
			return nil
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			failures := make([]string, len(pending))
			for i, check := range pending {
				failures[i] = check.failure
			}
			return errors.New(strings.Join(failures, "; "))
		}
		time.Sleep(min(interval, remaining))
	}
}
