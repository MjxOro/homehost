// Package incus implements worker.Incus on the native Incus API over the
// local unix socket. No CLI subprocesses: errors carry HTTP status codes, and
// instance config (user-data with passwords and keys) never appears in argv
// or error text.
package incus

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	incusclient "github.com/lxc/incus/v6/client"
	"github.com/lxc/incus/v6/shared/api"

	"github.com/MjxOro/homehost/apps/worker/internal/worker"
)

// callTimeout bounds every API operation the worker waits on, matching the
// 300s cap the CLI-based worker put on each `incus` invocation.
const callTimeout = 5 * time.Minute

// outputTail is how much combined guest output Exec keeps.
const outputTail = 8000

// imageProject holds the baked plan images (infra/host/build-images.sh).
const imageProject = "default"

// imageProperty tags every build of a baked image with its alias, in the
// image project and in each tenant copy, so older builds can be found.
const imageProperty = "homehost.image"

// Client is a worker.Incus backed by the local Incus daemon.
type Client struct {
	server incusclient.InstanceServer
}

var _ worker.Incus = (*Client)(nil)

// Connect opens the local daemon socket ($INCUS_SOCKET or the default path).
func Connect() (*Client, error) {
	server, err := incusclient.ConnectIncusUnix("", nil)
	if err != nil {
		return nil, fmt.Errorf("connect to incus: %w", err)
	}
	return &Client{server: server}, nil
}

func (c *Client) in(project string) incusclient.InstanceServer {
	return c.server.UseProject(project)
}

// classify wraps 404s in worker.ErrNotFound; Incus answers 404 for both a
// missing instance and a missing project.
func classify(err error, format string, args ...any) error {
	if err == nil {
		return nil
	}
	msg := fmt.Sprintf(format, args...)
	if api.StatusErrorCheck(err, http.StatusNotFound) {
		return fmt.Errorf("%s: %w: %w", msg, worker.ErrNotFound, err)
	}
	return fmt.Errorf("%s: %w", msg, err)
}

func wait(ctx context.Context, op incusclient.Operation) error {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	return op.WaitContext(ctx)
}

func (c *Client) EnsureProject(ctx context.Context, project string) error {
	if _, _, err := c.server.GetProject(project); err != nil {
		if !api.StatusErrorCheck(err, http.StatusNotFound) {
			return fmt.Errorf("incus project %s: %w", project, err)
		}
		err = c.server.CreateProject(api.ProjectsPost{Name: project})
		// A concurrent worker may have created it first.
		if err != nil && !api.StatusErrorCheck(err, http.StatusConflict) {
			return fmt.Errorf("incus project create %s: %w", project, err)
		}
	}
	// Fresh projects inherit an empty default profile: give it the pilot root
	// disk and bridge NIC, idempotently. Existing devices are left untouched.
	server := c.in(project)
	profile, etag, err := server.GetProfile("default")
	if err != nil {
		return fmt.Errorf("incus profile default in %s: %w", project, err)
	}
	put := profile.Writable()
	if put.Devices == nil {
		put.Devices = map[string]map[string]string{}
	}
	changed := false
	for name, device := range map[string]map[string]string{
		"root": {"type": "disk", "path": "/", "pool": "homehost"},
		"eth0": {"type": "nic", "network": "incusbr0", "name": "eth0"},
	} {
		if _, ok := put.Devices[name]; !ok {
			put.Devices[name] = device
			changed = true
		}
	}
	if !changed {
		return nil
	}
	if err := server.UpdateProfile("default", put, etag); err != nil {
		return fmt.Errorf("incus profile default in %s: %w", project, err)
	}
	return nil
}

// ensureImage makes the baked alias resolve to its current build inside
// project. Tenant projects keep their own image store (features.images, and
// projects holding instances cannot change it), so an alias in the image
// project is invisible there: the current build is copied in by fingerprint.
// Both projects share the pool's image volume, so the copy is a database
// record, not a second download. Older builds left in the project are
// deleted; instances created from them keep their own volumes.
func (c *Client) ensureImage(ctx context.Context, project, alias string) error {
	entry, _, err := c.in(imageProject).GetImageAlias(alias)
	if api.StatusErrorCheck(err, http.StatusNotFound) {
		return fmt.Errorf("image %s missing in project %s (build it with infra/host/build-images.sh): %w",
			alias, imageProject, worker.ErrImageMissing)
	}
	if err != nil {
		return fmt.Errorf("image alias %s: %w", alias, err)
	}
	if project == imageProject {
		return nil
	}
	server := c.in(project)
	current, _, err := server.GetImageAlias(alias)
	switch {
	case err == nil && current.Target == entry.Target:
	case err == nil || api.StatusErrorCheck(err, http.StatusNotFound):
		op, copyErr := server.CreateImage(api.ImagesPost{Source: &api.ImagesPostSource{
			Type:        "image",
			Mode:        "pull",
			Fingerprint: entry.Target,
			Project:     imageProject,
			// The daemon records an image source for the copy and rejects an
			// empty protocol.
			ImageSource: api.ImageSource{Protocol: "incus"},
		}}, nil)
		if copyErr == nil {
			copyErr = wait(ctx, op)
		}
		if copyErr != nil {
			return fmt.Errorf("copy image %s into %s: %w", alias, project, copyErr)
		}
		if err == nil {
			err = server.UpdateImageAlias(alias, api.ImageAliasesEntryPut{Target: entry.Target}, "")
		} else {
			err = server.CreateImageAlias(api.ImageAliasesPost{ImageAliasesEntry: api.ImageAliasesEntry{
				Name: alias, Type: entry.Type, ImageAliasesEntryPut: api.ImageAliasesEntryPut{Target: entry.Target},
			}})
		}
		if err != nil {
			return fmt.Errorf("image alias %s in %s: %w", alias, project, err)
		}
	default:
		return fmt.Errorf("image alias %s in %s: %w", alias, project, err)
	}
	images, err := server.GetImages()
	if err != nil {
		return fmt.Errorf("list images in %s: %w", project, err)
	}
	for _, image := range images {
		if image.Properties[imageProperty] != alias || image.Fingerprint == entry.Target {
			continue
		}
		op, err := server.DeleteImage(image.Fingerprint)
		if err == nil {
			err = wait(ctx, op)
		}
		if err != nil {
			return fmt.Errorf("delete old image %s in %s: %w", alias, project, err)
		}
	}
	return nil
}

func (c *Client) Launch(ctx context.Context, project, name string, spec worker.LaunchSpec) error {
	if err := c.ensureImage(ctx, project, spec.Image); err != nil {
		return fmt.Errorf("incus launch %s: %w", name, err)
	}
	server := c.in(project)
	// `-d root,size=` semantics: copy the root device the default profile
	// would apply and override its size.
	profile, _, err := server.GetProfile("default")
	if err != nil {
		return fmt.Errorf("incus launch %s: load default profile: %w", name, err)
	}
	root, ok := profile.Devices["root"]
	if !ok {
		return fmt.Errorf("incus launch %s: default profile in %s has no root device", name, project)
	}
	root = maps.Clone(root)
	root["size"] = fmt.Sprintf("%dGiB", spec.RootSizeGiB)

	instanceType := api.InstanceTypeContainer
	if spec.VM {
		instanceType = api.InstanceTypeVM
	}
	req := api.InstancesPost{
		Name:  name,
		Type:  instanceType,
		Start: true,
		Source: api.InstanceSource{
			Type:  "image",
			Alias: spec.Image,
		},
		InstancePut: api.InstancePut{
			Config:   spec.Config,
			Devices:  map[string]map[string]string{"root": root},
			Profiles: []string{"default"},
		},
	}
	op, err := server.CreateInstance(req)
	if err != nil {
		return fmt.Errorf("incus launch %s: %w", name, err)
	}
	if err := wait(ctx, op); err != nil {
		return fmt.Errorf("incus launch %s: %w", name, err)
	}
	return nil
}

func (c *Client) Delete(ctx context.Context, project, name string) error {
	server := c.in(project)
	inst, _, err := server.GetInstance(name)
	if err != nil {
		return classify(err, "incus delete %s", name)
	}
	if inst.StatusCode != 0 && inst.StatusCode != api.Stopped {
		op, err := server.UpdateInstanceState(name, api.InstanceStatePut{Action: "stop", Timeout: -1, Force: true}, "")
		if err == nil {
			err = wait(ctx, op)
		}
		if err != nil {
			return classify(err, "incus delete %s: force stop", name)
		}
	}
	op, err := server.DeleteInstance(name)
	if err == nil {
		err = wait(ctx, op)
	}
	return classify(err, "incus delete %s", name)
}

func (c *Client) Exists(ctx context.Context, project, name string) (bool, error) {
	_, _, err := c.in(project).GetInstance(name)
	if err == nil {
		return true, nil
	}
	if api.StatusErrorCheck(err, http.StatusNotFound) {
		return false, nil
	}
	return false, fmt.Errorf("incus get %s: %w", name, err)
}

func (c *Client) State(ctx context.Context, project, name string) (worker.InstanceState, error) {
	state, _, err := c.in(project).GetInstanceState(name)
	if err != nil {
		return worker.InstanceState{}, classify(err, "incus state %s", name)
	}
	result := worker.InstanceState{Status: state.Status}
	// Last non-loopback IPv4 in interface-name order: the order the daemon's
	// JSON (and so the CLI-based worker) presented them in.
	for _, iface := range slices.Sorted(maps.Keys(state.Network)) {
		if iface == "lo" {
			continue
		}
		for _, addr := range state.Network[iface].Addresses {
			if addr.Family == "inet" && !strings.HasPrefix(addr.Address, "127.") {
				result.IPv4 = addr.Address
			}
		}
	}
	return result, nil
}

func (c *Client) SetPower(ctx context.Context, project, name, action string) error {
	op, err := c.in(project).UpdateInstanceState(name, api.InstanceStatePut{Action: action, Timeout: -1}, "")
	if err == nil {
		err = wait(ctx, op)
	}
	return classify(err, "incus %s %s", action, name)
}

// tailBuffer keeps the last limit bytes written to it.
type tailBuffer struct {
	mu        sync.Mutex
	limit     int
	buf       []byte
	truncated bool
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - t.limit; over > 0 {
		t.buf = slices.Clone(t.buf[over:])
		t.truncated = true
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

func (t *tailBuffer) snapshot() ([]byte, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return slices.Clone(t.buf), t.truncated
}

func (c *Client) Exec(ctx context.Context, project, name string, argv []string, timeout time.Duration) worker.ExecResult {
	output := &tailBuffer{limit: outputTail}
	dataDone := make(chan bool)
	control := make(chan *websocket.Conn, 1)
	op, err := c.in(project).ExecInstance(name, api.InstanceExecPost{
		Command:   argv,
		WaitForWS: true,
	}, &incusclient.InstanceExecArgs{
		// An empty reader closes the guest's stdin at once; a nil one would
		// leave it open and let a prompt block forever.
		Stdin:    bytes.NewReader(nil),
		Stdout:   output,
		Stderr:   output,
		Control:  func(conn *websocket.Conn) { control <- conn },
		DataDone: dataDone,
	})
	if err != nil {
		return worker.ExecResult{Output: fmt.Sprintf("incus exec %s: %v", name, err)}
	}

	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	err = op.WaitContext(waitCtx)
	if errors.Is(err, context.DeadlineExceeded) {
		// Kill the guest process; the operation then completes on its own.
		select {
		case conn := <-control:
			_ = conn.WriteJSON(api.InstanceExecControl{Command: "signal", Signal: int(syscall.SIGKILL)})
		default:
		}
		return worker.ExecResult{TimedOut: true, Output: output.String()}
	}
	if err != nil {
		return worker.ExecResult{Output: fmt.Sprintf("%s\nincus exec %s: %v", output.String(), name, err)}
	}
	// Output streams finish after the operation; wait so the tail is complete.
	select {
	case <-dataDone:
	case <-time.After(10 * time.Second):
	}
	code, ok := op.Get().Metadata["return"].(float64)
	if !ok {
		return worker.ExecResult{Output: fmt.Sprintf("%s\nincus exec %s: no exit code", output.String(), name)}
	}
	exit := int(code)
	return worker.ExecResult{ExitCode: &exit, Output: output.String()}
}

// Run executes one agent command, keeping the tail of stdout and stderr.
func (c *Client) Run(ctx context.Context, project, name string, spec worker.RunSpec) worker.RunResult {
	stdout := &tailBuffer{limit: spec.MaxBytes}
	stderr := &tailBuffer{limit: spec.MaxBytes}
	dataDone := make(chan bool)
	control := make(chan *websocket.Conn, 1)
	op, err := c.in(project).ExecInstance(name, api.InstanceExecPost{
		Command:   spec.Argv,
		Cwd:       spec.Cwd,
		WaitForWS: true,
	}, &incusclient.InstanceExecArgs{
		Stdin:    bytes.NewReader(nil),
		Stdout:   stdout,
		Stderr:   stderr,
		Control:  func(conn *websocket.Conn) { control <- conn },
		DataDone: dataDone,
	})
	if err != nil {
		return worker.RunResult{Err: fmt.Errorf("incus exec %s: %w", name, err)}
	}

	result := func() worker.RunResult {
		out, outTruncated := stdout.snapshot()
		errOut, errTruncated := stderr.snapshot()
		return worker.RunResult{
			Stdout: out, Stderr: errOut,
			StdoutTruncated: outTruncated, StderrTruncated: errTruncated,
		}
	}

	waitCtx, cancel := context.WithTimeout(ctx, spec.Timeout)
	defer cancel()
	err = op.WaitContext(waitCtx)
	if errors.Is(err, context.DeadlineExceeded) {
		// Kill the guest process; the operation then completes on its own.
		select {
		case conn := <-control:
			_ = conn.WriteJSON(api.InstanceExecControl{Command: "signal", Signal: int(syscall.SIGKILL)})
		default:
		}
		res := result()
		res.TimedOut = true
		return res
	}
	if err != nil {
		res := result()
		res.Err = fmt.Errorf("incus exec %s: %w", name, err)
		return res
	}
	// Output streams finish after the operation; wait so the buffers are complete.
	select {
	case <-dataDone:
	case <-time.After(10 * time.Second):
	}
	res := result()
	code, ok := op.Get().Metadata["return"].(float64)
	if !ok {
		res.Err = fmt.Errorf("incus exec %s: no exit code", name)
		return res
	}
	exit := int(code)
	res.ExitCode = &exit
	return res
}

// ReadFile returns up to maxBytes of the guest file at path, keeping its head.
func (c *Client) ReadFile(ctx context.Context, project, name, path string, maxBytes int) ([]byte, bool, error) {
	body, resp, err := c.in(project).GetInstanceFile(name, path)
	if err != nil {
		return nil, false, classify(err, "incus read %s %s", name, path)
	}
	defer body.Close()
	if resp.Type == "directory" {
		return nil, false, fmt.Errorf("incus read %s %s: %w", name, path, worker.ErrIsDirectory)
	}
	// One byte past the limit tells a truncated read from an exact fit.
	data, err := io.ReadAll(io.LimitReader(body, int64(maxBytes)+1))
	if err != nil {
		return nil, false, fmt.Errorf("incus read %s %s: %w", name, path, err)
	}
	if len(data) > maxBytes {
		return data[:maxBytes], true, nil
	}
	return data, false, nil
}

// WriteFile replaces the guest file at path, owned by root. A zero mode means 0644.
func (c *Client) WriteFile(ctx context.Context, project, name, path string, content []byte, mode int) error {
	if mode == 0 {
		mode = 0o644
	}
	err := c.in(project).CreateInstanceFile(name, path, incusclient.InstanceFileArgs{
		Content:   bytes.NewReader(content),
		Mode:      mode,
		Type:      "file",
		WriteMode: "overwrite",
	})
	return classify(err, "incus write %s %s", name, path)
}
