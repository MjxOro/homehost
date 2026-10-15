package worker

import (
	"context"
	"errors"
	"time"
)

// ErrNotFound marks a missing Incus instance or project. Teardown treats it
// as the desired end state.
var ErrNotFound = errors.New("not found")

// ErrIsDirectory marks a guest path that is a directory where a file was
// expected.
var ErrIsDirectory = errors.New("is a directory")

// ErrImageMissing marks a plan image that was never baked on this host
// (infra/host/build-images.sh). Retrying cannot help, so provisioning fails
// the job at once instead of falling back to a slow upstream image.
var ErrImageMissing = errors.New("baked image missing")

// LaunchSpec is one tenant instance as `incus launch` would create it.
type LaunchSpec struct {
	// Image is a baked image alias, e.g. homehost/ubuntu-24.04/vm.
	Image string
	VM    bool
	// Config holds instance config keys (limits, user-data, nesting).
	Config map[string]string
	// RootSizeGiB overrides the size of the profile's root disk.
	RootSizeGiB int
	// GPU shares the host's NVIDIA GPU with a container: the gpu device plus
	// the host's driver userspace (nvidia.runtime). Launch refuses it for VMs,
	// where the device would pass the whole card through.
	GPU bool
}

// InstanceState is the live status ("Running", "Stopped", ...) and the
// guest's IPv4 address, empty while it has none.
type InstanceState struct {
	Status string
	IPv4   string
}

// ExecResult is one guest command run. ExitCode is nil when the command
// never reported one (transport failure or kill); Output is the combined
// stdout/stderr tail.
type ExecResult struct {
	ExitCode *int
	TimedOut bool
	Output   string
}

// RunSpec is one guest command for Incus.Run. Argv runs with stdin closed
// and killed after Timeout; Cwd is empty for the guest default; each stream
// keeps at most MaxBytes.
type RunSpec struct {
	Argv     []string
	Cwd      string
	Timeout  time.Duration
	MaxBytes int
}

// RunResult is the outcome of Incus.Run. Err is set only on a transport
// failure, when no exit status was observed. Both streams keep their tail.
type RunResult struct {
	ExitCode        *int
	TimedOut        bool
	Stdout          []byte
	Stderr          []byte
	StdoutTruncated bool
	StderrTruncated bool
	Err             error
}

// Incus is the slice of the Incus API the worker drives. Every call is
// scoped to one tenant project.
type Incus interface {
	// EnsureProject creates the project if missing and gives its default
	// profile the root disk and bridge NIC tenant launches depend on.
	EnsureProject(ctx context.Context, project string) error
	// Launch creates and starts an instance.
	Launch(ctx context.Context, project, name string, spec LaunchSpec) error
	// Delete force-stops and deletes an instance; wraps ErrNotFound when the
	// instance or its project is missing.
	Delete(ctx context.Context, project, name string) error
	// Exists is false (without error) when the instance or project is missing.
	Exists(ctx context.Context, project, name string) (bool, error)
	State(ctx context.Context, project, name string) (InstanceState, error)
	// SetPower runs the "start" or "stop" state action.
	SetPower(ctx context.Context, project, name, action string) error
	// Exec runs argv in the guest with stdin closed, killing it after timeout.
	Exec(ctx context.Context, project, name string, argv []string, timeout time.Duration) ExecResult
	// Run executes one agent command (machine_execs) with bounded output.
	Run(ctx context.Context, project, name string, spec RunSpec) RunResult
	// ReadFile returns up to maxBytes of the guest file at path, keeping its
	// head; truncated reports more data. Wraps ErrNotFound for a missing path
	// and ErrIsDirectory for a directory.
	ReadFile(ctx context.Context, project, name, path string, maxBytes int) (data []byte, truncated bool, err error)
	// WriteFile replaces the guest file at path (uid/gid 0). A zero mode
	// means 0644.
	WriteFile(ctx context.Context, project, name, path string, content []byte, mode int) error
}

// DNS manages per-box public AAAA records.
type DNS interface {
	EnsureAAAA(ctx context.Context, name, ipv6 string) error
	DeleteAAAA(ctx context.Context, name string) error
	// Visible reports whether public DNS already answers name with ipv6.
	Visible(ctx context.Context, name, ipv6 string) (bool, error)
}
