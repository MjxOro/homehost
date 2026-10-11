package worker

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/MjxOro/homehost/apps/worker/internal/contract"
)

const workerActor = "Homehost worker"

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// tail is the last n bytes of s, starting on a rune boundary.
func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	start := len(s) - n
	for start < len(s) && !utf8.RuneStart(s[start]) {
		start++
	}
	return s[start:]
}

func (w *Worker) handle(ctx context.Context, j *job) error {
	switch j.action {
	case "provision":
		return w.handleProvision(ctx, j)
	case "teardown":
		return w.handleTeardown(ctx, j)
	case "stop":
		return w.handlePower(ctx, j, "stop", "stopped")
	case "start":
		return w.handlePower(ctx, j, "start", "running")
	case "setup":
		return w.handleSetup(ctx, j)
	}
	return w.finishJob(ctx, j.id, "failed", new("unknown action "+j.action))
}

// retryOrFail requeues a failed attempt, or records the terminal failure via
// fail once the job used its attempts.
func (w *Worker) retryOrFail(ctx context.Context, j *job, cause error, limit int, fail func(string) error) error {
	if j.attempts >= limit {
		return fail(cause.Error())
	}
	return w.requeue(ctx, j.id, cause.Error())
}

func (w *Worker) handleProvision(ctx context.Context, j *job) error {
	req, err := w.loadRequest(ctx, j.requestID)
	if err != nil {
		return err
	}
	if req == nil || req.status == "deleted" {
		// Cancelled while queued: nothing to build.
		return w.finishJob(ctx, j.id, "done", new("skipped: deleted"))
	}
	if req.status != "approved" && req.status != "provisioning" {
		return w.finishJob(ctx, j.id, "failed", new("unexpected status "+req.status))
	}
	plan := contract.PlanByID(req.planID)
	if plan == nil {
		return w.failProvision(ctx, req, j, "unknown plan "+req.planID)
	}
	// Desktop plans are VM-only: containers ignore cloud-init, so a desktop
	// bake could never boot there. Omarchy has no non-interactive installer,
	// so both refuse the job closed with an actionable message.
	if plan.Desktop != nil && plan.Kind != "vm" {
		return w.failProvision(ctx, req, j, fmt.Sprintf("desktop plan %s requires a vm", plan.ID))
	}
	if plan.Desktop != nil && plan.Desktop.Env == "omarchy" {
		return w.failProvision(ctx, req, j, omarchyUnavailable(plan.ID, plan.Image))
	}
	if err := w.provision(ctx, req, plan, j); err != nil {
		if errors.Is(err, ErrImageMissing) {
			return w.failProvision(ctx, req, j, err.Error())
		}
		return w.retryOrFail(ctx, j, err, w.cfg.ProvisionAttempts, func(msg string) error {
			return w.failProvision(ctx, req, j, msg)
		})
	}
	return nil
}

func (w *Worker) provision(ctx context.Context, req *request, plan *contract.Plan, j *job) error {
	project := projectForReq(req)
	name := deref(req.instanceName)
	if name == "" {
		name = instanceNameOf(req.id, req.subdomain)
	}
	if err := w.incus.EnsureProject(ctx, project); err != nil {
		return err
	}
	if req.status == "approved" {
		if err := w.setRequest(ctx, req.id, "provisioning", &name, nil); err != nil {
			return err
		}
		if err := w.emit(ctx, req.id, workerActor, "provisioning", req.name, nil); err != nil {
			return err
		}
	}
	// Idempotent launch: a crashed earlier attempt may have left a partial instance.
	_ = w.incus.Delete(ctx, project, name)

	isVM := plan.Kind == "vm"
	spec := LaunchSpec{
		Image: plan.Image,
		VM:    isVM,
		Config: map[string]string{
			"limits.cpu":    strconv.Itoa(plan.CPU),
			"limits.memory": fmt.Sprintf("%dMiB", plan.MemoryMb),
		},
		RootSizeGiB: plan.DiskGb,
	}
	if !isVM {
		spec.Config["security.nesting"] = "true"
	}

	// The API stores desktop_env/hostname/port on the row (migration 0010);
	// when the row lacks them (pre-migration), derive from the plan the same
	// way the API does.
	desktop := plan.Desktop
	var desktopEnv, desktopHostname string
	var desktopPort int
	if desktop != nil {
		desktopEnv, desktopHostname, desktopPort = desktop.Env, contract.ToDesktopHostname(req.subdomain), desktop.KasmPort
		if stored := w.loadDesktopFields(ctx, req.id); stored != nil {
			if stored.env != nil {
				desktopEnv = *stored.env
			}
			if stored.hostname != nil {
				desktopHostname = *stored.hostname
			}
			if stored.port != nil {
				desktopPort = int(*stored.port)
			}
		}
	}
	bakeDesktop := desktop != nil && desktopEnv == "ubuntu-xfce"

	// SSH access for every plan: VMs via cloud-init user-data at launch,
	// containers via in-guest sshd setup after boot (they ignore cloud-init).
	// Access is decided at launch: deleted-while-queued requests never mint
	// secrets. The password persists for its one dashboard read.
	var ipv6 string
	if isVM {
		password := newPassword()
		userData := buildUserData(deref(req.sshPubkey), password)
		// The desktop gets its own persistent secret (desktop_password),
		// independent of the one-read root OTP. The panel proxy injects it as
		// Basic auth; the browser never sees it.
		var desktopPassword *string
		if bakeDesktop {
			desktopPassword = new(newPassword())
			var err error
			if userData, err = appendDesktopToUserData(userData, *desktop, desktop.User, *desktopPassword); err != nil {
				return err
			}
		}
		spec.Config["user.user-data"] = userData
		// Static v6 from the routed prefix; skipped entirely on v4-only hosts.
		ipv6 = contract.Ipv6ForInstance(w.cfg.IPv6Prefix, req.id)
		if ipv6 != "" {
			spec.Config["user.network-config"] = buildNetConfig(ipv6, gatewayOf(w.cfg.IPv6Prefix))
		}
		if err := w.setInstancePassword(ctx, req.id, password); err != nil {
			return err
		}
		if err := w.setDesktopPassword(ctx, req.id, desktopPassword); err != nil {
			return err
		}
	}
	if err := w.incus.Launch(ctx, project, name, spec); err != nil {
		return err
	}
	ipv4 := w.waitForAddress(ctx, project, name)
	if ipv4 == "" {
		return errors.New("timed out waiting for instance address")
	}
	if !isVM {
		// Same password shape as the VM path; a nonzero guest exit fails the
		// attempt so the attempts-capped requeue covers apt flakes. Containers
		// get the same static v6 as VMs, applied in-guest.
		password := newPassword()
		containerIPv6 := contract.Ipv6ForInstance(w.cfg.IPv6Prefix, req.id)
		if containerIPv6 != "" {
			ipv6 = containerIPv6
		}
		if err := w.setInstancePassword(ctx, req.id, password); err != nil {
			return err
		}
		if err := w.provisionContainerSSH(ctx, project, name, password, deref(req.sshPubkey), containerIPv6); err != nil {
			return err
		}
	}
	// Direct IPv6 access for every plan: no leased ports, no NAT rules.
	if ipv6 != "" {
		if err := w.setIpv6(ctx, req.id, ipv6); err != nil {
			return err
		}
		if w.dns != nil {
			if err := w.dns.EnsureAAAA(ctx, req.subdomain, ipv6); err != nil {
				return err
			}
		} else {
			w.log.Print("CF_DNS_API_TOKEN unset: skipping AAAA")
		}
		if err := w.waitForReachable(ctx, req, ipv6); err != nil {
			return err
		}
	}
	if bakeDesktop && desktopHostname != "" {
		// Backend is the guest IPv4 (the edge net has no v6). Desktop DNS is
		// wildcard-only, so no per-VM desktop record is written here.
		if err := w.writeDesktopRoute(desktopRoute{
			instanceName:    name,
			desktopHostname: desktopHostname,
			backendHost:     ipv4,
			kasmPort:        desktopPort,
		}); err != nil {
			return err
		}
	}
	if err := w.setRequest(ctx, req.id, "running", &name, &ipv4); err != nil {
		return err
	}
	if err := w.emit(ctx, req.id, workerActor, "running", req.name, &ipv4); err != nil {
		return err
	}
	// The readiness gate passed: now install the recipe, if any.
	if err := w.enqueueSetupIfPending(ctx, req.id); err != nil {
		return err
	}
	return w.finishJob(ctx, j.id, "done", nil)
}

// failProvision parks the request at approved: the reservation and the
// retry path survive.
func (w *Worker) failProvision(ctx context.Context, req *request, j *job, message string) error {
	if err := w.setRequest(ctx, req.id, "approved", req.instanceName, nil); err != nil {
		return err
	}
	if err := w.emit(ctx, req.id, workerActor, "provision_failed", req.name, &message); err != nil {
		return err
	}
	return w.finishJob(ctx, j.id, "failed", &message)
}

func (w *Worker) provisionContainerSSH(ctx context.Context, project, name, password, sshPubkey, containerIPv6 string) error {
	script := containerSSHScript(password, sshPubkey, containerIPv6, w.cfg.IPv6Prefix)
	run := w.incus.Exec(ctx, project, name, []string{"sh", "-euc", script}, 5*time.Minute)
	if run.ExitCode != nil && *run.ExitCode == 0 && !run.TimedOut {
		return nil
	}
	reason := "timed out"
	if !run.TimedOut {
		reason = "no exit code"
		if run.ExitCode != nil {
			reason = fmt.Sprintf("exit %d", *run.ExitCode)
		}
	}
	return fmt.Errorf("incus exec %s: sshd setup failed (%s)\n%s", name, reason, strings.TrimSpace(run.Output))
}

func (w *Worker) waitForAddress(ctx context.Context, project, name string) string {
	deadline := time.Now().Add(w.cfg.BootTimeout)
	for time.Now().Before(deadline) {
		if w.shuttingDown() {
			return ""
		}
		state, err := w.incus.State(ctx, project, name)
		if err == nil && state.Status == "Running" && state.IPv4 != "" {
			return state.IPv4
		}
		w.sleep(5 * time.Second)
	}
	return ""
}

// waitForReachable gates "running" on the box answering at its public v6
// address: catches a lost bridge gateway/route or a dead sshd, and a
// record resolvers can't see yet.
func (w *Worker) waitForReachable(ctx context.Context, req *request, ipv6 string) error {
	if err := w.emit(ctx, req.id, workerActor, "provisioning", req.name, new("Checking network reachability")); err != nil {
		return err
	}
	checks := []readinessCheck{{
		failure: fmt.Sprintf("box not reachable at [%s]:22 (check the incusbr0 gateway)", ipv6),
		run: func(ctx context.Context) (bool, error) {
			return w.probeTCP(ctx, ipv6, 22), nil
		},
	}}
	if w.dns != nil {
		checks = append(checks, readinessCheck{
			failure: "hostname not visible on public DNS yet",
			run: func(ctx context.Context) (bool, error) {
				return w.dns.Visible(ctx, req.subdomain, ipv6)
			},
		})
	}
	return pollChecks(ctx, checks, w.cfg.ReadyTimeout, 2*time.Second)
}

func (w *Worker) handleTeardown(ctx context.Context, j *job) error {
	req, err := w.loadRequest(ctx, j.requestID)
	if err != nil {
		return err
	}
	if req == nil {
		// Purged request: nothing else to clean, but never leave its history open.
		if err := w.releaseIpv6(ctx, j.requestID); err != nil {
			return err
		}
		return w.finishJob(ctx, j.id, "done", new("nothing to tear down"))
	}
	if err := w.teardown(ctx, req, j); err != nil {
		return w.retryOrFail(ctx, j, err, w.cfg.TeardownAttempts, func(msg string) error {
			return w.finishJob(ctx, j.id, "failed", &msg)
		})
	}
	return nil
}

func (w *Worker) teardown(ctx context.Context, req *request, j *job) error {
	// A terminal provision failure can clear instance_name after allocation:
	// use the same deterministic name as launch before closing its history.
	name := deref(req.instanceName)
	if name == "" {
		name = instanceNameOf(req.id, req.subdomain)
	}
	project := projectForReq(req)
	if err := w.incus.Delete(ctx, project, name); err != nil && !errors.Is(err, ErrNotFound) {
		// Already gone is the desired end state; any other failure (daemon
		// down) retries unless the instance is verifiably absent.
		exists, existsErr := w.incus.Exists(ctx, project, name)
		if existsErr != nil {
			return existsErr
		}
		if exists {
			return err
		}
	}
	// The instance is confirmed gone: close its history before DNS and route
	// cleanup so a failing cleanup cannot leave the address assigned.
	if err := w.releaseIpv6(ctx, req.id); err != nil {
		return err
	}
	if w.dns != nil {
		if err := w.dns.DeleteAAAA(ctx, req.subdomain); err != nil {
			return err
		}
	}
	// Desktop VMs only: best-effort route-file cleanup (desktop DNS is
	// wildcard-only). Omarchy rows never write one; removing is harmless.
	if plan := contract.PlanByID(req.planID); plan != nil && plan.Desktop != nil {
		if err := w.removeDesktopRoute(name); err != nil {
			w.log.Printf("desktop route remove failed: %v", err)
		}
	}
	return w.finishJob(ctx, j.id, "done", nil)
}

func (w *Worker) handlePower(ctx context.Context, j *job, verb, to string) error {
	req, err := w.loadRequest(ctx, j.requestID)
	if err != nil {
		return err
	}
	if req == nil || req.instanceName == nil {
		return w.finishJob(ctx, j.id, "failed", new("request or instance missing"))
	}
	if err := w.power(ctx, req, j, verb, to); err != nil {
		return w.retryOrFail(ctx, j, err, w.cfg.PowerAttempts, func(msg string) error {
			return w.finishJob(ctx, j.id, "failed", &msg)
		})
	}
	return nil
}

func (w *Worker) power(ctx context.Context, req *request, j *job, verb, to string) error {
	project := projectForReq(req)
	name := *req.instanceName
	// Idempotent verb: a retried job finds the instance already flipped and
	// proceeds to the row update instead of failing on a redundant command.
	state, err := w.incus.State(ctx, project, name)
	if err != nil || strings.ToLower(state.Status) != to {
		if err := w.incus.SetPower(ctx, project, name, verb); err != nil {
			return err
		}
	}
	var ipv4 *string
	if verb == "start" {
		// A slow boot requeues like provision: a running row must never point
		// at a stale or missing address.
		address := w.waitForAddress(ctx, project, name)
		if address == "" {
			return errors.New("timed out waiting for instance address")
		}
		ipv4 = &address
	}
	if err := w.setRequest(ctx, req.id, to, req.instanceName, ipv4); err != nil {
		return err
	}
	if err := w.emit(ctx, req.id, req.ownerName, to, req.name, nil); err != nil {
		return err
	}
	// A setup skipped while the box was stopped resumes on start.
	if to == "running" {
		if err := w.enqueueSetupIfPending(ctx, req.id); err != nil {
			return err
		}
	}
	return w.finishJob(ctx, j.id, "done", nil)
}

func (w *Worker) handleSetup(ctx context.Context, j *job) error {
	req, err := w.loadRequest(ctx, j.requestID)
	if err != nil {
		return err
	}
	if req == nil || req.status == "deleted" {
		return w.finishJob(ctx, j.id, "done", new("skipped: deleted"))
	}
	state, err := w.loadSetupState(ctx, req.id)
	if err != nil {
		return err
	}
	if state == nil || state.recipeID == nil || (state.setupStatus != "pending" && state.setupStatus != "running") {
		status := "missing"
		if state != nil {
			status = state.setupStatus
		}
		return w.finishJob(ctx, j.id, "done", new("skipped: setup "+status))
	}
	if req.status != "running" || req.instanceName == nil {
		// Stopped before setup ran: stays pending, the next start re-enqueues it.
		if err := w.setSetup(ctx, req.id, "pending", nil, nil); err != nil {
			return err
		}
		return w.finishJob(ctx, j.id, "done", new("skipped: status "+req.status))
	}
	recipeID := *state.recipeID
	var setup *contract.SetupPlan
	if plan := contract.PlanByID(req.planID); plan != nil {
		setup = contract.PlanSetup(recipeID, plan.ID)
	}
	if setup == nil {
		return w.failSetup(ctx, req, j, nil, "unknown", "no setup for "+recipeID)
	}
	if recipe := contract.RecipeByID(recipeID); recipe.Eula != nil && !state.eulaAccepted {
		return w.failSetup(ctx, req, j, nil, "unknown", "license acceptance missing")
	}
	if j.attempts > w.cfg.SetupAttempts {
		return w.failSetup(ctx, req, j, nil, "unknown", "setup interrupted too often")
	}
	project := projectForReq(req)
	instance := *req.instanceName
	if err := w.setSetup(ctx, req.id, "running", nil, nil); err != nil {
		return err
	}
	if err := w.emit(ctx, req.id, workerActor, "setup_started", req.name, &recipeID); err != nil {
		return err
	}
	for _, step := range setup.Steps {
		if w.shuttingDown() {
			// Re-leased on the next start; the scripts are safe to re-run.
			return w.requeue(ctx, j.id, "worker shutting down")
		}
		if err := w.setSetup(ctx, req.id, "running", &step.ID, nil); err != nil {
			return err
		}
		script, err := setupScript(step.ID, setup.HeapMb)
		if err != nil {
			return err
		}
		timeout := time.Duration(step.TimeoutMs) * time.Millisecond
		for attempt := 1; ; attempt++ {
			run := w.incus.Exec(ctx, project, instance, []string{"bash", "-euo", "pipefail", "-c", script}, timeout)
			if run.ExitCode != nil && *run.ExitCode == 0 && !run.TimedOut {
				break
			}
			code := contract.SetupErrorOf(step.ID, run.ExitCode, run.TimedOut)
			if attempt < contract.SetupStepAttempts && !w.shuttingDown() && contract.IsTransientSetupFailure(code, run.Output) {
				w.sleep(time.Duration(15*attempt) * time.Second)
				if w.shuttingDown() {
					return w.requeue(ctx, j.id, "worker shutting down")
				}
				continue
			}
			return w.failSetup(ctx, req, j, &step.ID, code, run.Output)
		}
		if step.ID == "wait_ready" && state.ipv6 != nil {
			// Listening in the box is not enough: players come in over IPv6.
			ipv6 := *state.ipv6
			port := contract.MinecraftPort
			err := pollChecks(ctx, []readinessCheck{{
				failure: fmt.Sprintf("not reachable at [%s]:%d", ipv6, port),
				run: func(ctx context.Context) (bool, error) {
					return w.probeTCP(ctx, ipv6, port), nil
				},
			}}, w.cfg.ReadyTimeout, 3*time.Second)
			if err != nil {
				return w.failSetup(ctx, req, j, &step.ID, "not_ready", err.Error())
			}
		}
	}
	last := setup.Steps[len(setup.Steps)-1].ID
	if err := w.setSetup(ctx, req.id, "done", &last, nil); err != nil {
		return err
	}
	detail := recipeID
	if address := contract.GameAddressOf(&recipeID, "done", req.subdomain); address != nil {
		detail = *address
	}
	if err := w.emit(ctx, req.id, workerActor, "setup_done", req.name, &detail); err != nil {
		return err
	}
	return w.finishJob(ctx, j.id, "done", nil)
}

// failSetup leaves the box as it is: setup failures never reimage or relaunch.
func (w *Worker) failSetup(ctx context.Context, req *request, j *job, step *string, code, detail string) error {
	if err := w.setSetup(ctx, req.id, "failed", step, &code); err != nil {
		return err
	}
	if err := w.emit(ctx, req.id, workerActor, "setup_failed", req.name, &code); err != nil {
		return err
	}
	msg := code
	if step != nil {
		msg += " at " + *step
	}
	msg += ": " + tail(detail, 2000)
	return w.finishJob(ctx, j.id, "failed", &msg)
}
