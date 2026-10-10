package worker

import (
	"context"
	"errors"
	"time"
)

// ErrNotFound marks a missing Incus instance or project. Teardown treats it
// as the desired end state.
var ErrNotFound = errors.New("not found")

// LaunchSpec is one tenant instance as `incus launch` would create it.
type LaunchSpec struct {
	// Image is a remote-qualified alias, e.g. images:ubuntu/24.04.
	Image string
	VM    bool
	// Config holds instance config keys (limits, user-data, nesting).
	Config map[string]string
	// RootSizeGiB overrides the size of the profile's root disk.
	RootSizeGiB int
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
}

// DNS manages per-box public AAAA records.
type DNS interface {
	EnsureAAAA(ctx context.Context, name, ipv6 string) error
	DeleteAAAA(ctx context.Context, name string) error
	// Visible reports whether public DNS already answers name with ipv6.
	Visible(ctx context.Context, name, ipv6 string) (bool, error)
}
