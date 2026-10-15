package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeReleases serves a GitHub-style release listing plus the assets of one
// CLI release. The "binary" is a shell script that prints its version, which
// is what the updater's smoke run checks.
type fakeReleases struct {
	url       string
	version   string
	binary    []byte
	checksums string
	listings  int
	downloads int
}

func newFakeReleases(t *testing.T, version string) *fakeReleases {
	t.Helper()
	f := &fakeReleases{
		version: version,
		binary:  []byte("#!/bin/sh\necho \"homehost " + version + "\"\n"),
	}
	sum := sha256.Sum256(f.binary)
	f.checksums = hex.EncodeToString(sum[:]) + "  " + assetName() + "\n"
	srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/releases":
			f.listings++
			base := "http://" + r.Host
			listing := []release{
				{Tag: "v9.9.9", Assets: nil},
				{Tag: "cli-v0.0.1"},
				{Tag: "cli-" + f.version, Assets: []releaseAsset{
					{Name: assetName(), URL: base + "/bin"},
					{Name: checksumsAsset, URL: base + "/sums"},
				}},
				{Tag: "cli-v99.0.0", Draft: true},
			}
			raw, _ := json.Marshal(listing)
			respond(w, http.StatusOK, string(raw))
		case "/sums":
			_, _ = w.Write([]byte(f.checksums))
		case "/bin":
			f.downloads++
			_, _ = w.Write(f.binary)
		default:
			http.NotFound(w, r)
		}
	})
	f.url = srv.URL
	return f
}

func updateHarness(t *testing.T, f *fakeReleases, current string) (*harness, string) {
	t.Helper()
	h := newHarness(t, map[string]string{"HOMEHOST_RELEASES_URL": f.url + "/releases"})
	target := filepath.Join(t.TempDir(), "homehost")
	if err := os.WriteFile(target, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	h.app.version = current
	h.app.executable = func() (string, error) { return target, nil }
	return h, target
}

func TestNewerThan(t *testing.T) {
	for _, tc := range []struct {
		candidate, current string
		want               bool
	}{
		{"v0.2.0", "v0.1.9", true},
		{"v0.10.0", "v0.9.0", true},
		{"v1.0.0", "v1.0.0", false},
		{"v0.9.0", "v1.0.0", false},
		{"v0.1.0", "dev", true},
		{"dev", "v0.1.0", false},
		{"0.2.0", "v0.1.0", false},
	} {
		if got := newerThan(tc.candidate, tc.current); got != tc.want {
			t.Errorf("newerThan(%q, %q) = %v, want %v", tc.candidate, tc.current, got, tc.want)
		}
	}
}

func TestUpdateReplacesBinaryWithVerifiedRelease(t *testing.T) {
	f := newFakeReleases(t, "v0.3.0")
	h, target := updateHarness(t, f, "v0.2.0")
	if code := h.run("update"); code != 0 {
		t.Fatalf("exit %d, stderr %q", code, h.stderr.String())
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != string(f.binary) {
		t.Fatalf("binary not replaced: %q, %v", got, err)
	}
	if info, _ := os.Stat(target); info.Mode().Perm() != 0o755 {
		t.Fatalf("mode = %v", info.Mode())
	}
	if !strings.Contains(h.stdout.String(), "updated homehost v0.2.0 -> v0.3.0") {
		t.Fatalf("stdout = %q", h.stdout.String())
	}
	if leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(target), ".homehost-update-*")); len(leftovers) != 0 {
		t.Fatalf("staging files left behind: %v", leftovers)
	}
}

func TestUpdateRefusesChecksumMismatch(t *testing.T) {
	f := newFakeReleases(t, "v0.3.0")
	f.checksums = strings.Repeat("0", 64) + "  " + assetName() + "\n"
	h, target := updateHarness(t, f, "v0.2.0")
	if code := h.run("update"); code != 1 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(h.stderr.String(), "(checksum_mismatch)") {
		t.Fatalf("stderr = %q", h.stderr.String())
	}
	if got, _ := os.ReadFile(target); string(got) != "old binary" {
		t.Fatalf("binary changed despite mismatch: %q", got)
	}
}

func TestUpdateWhenCurrentAndCheckOnly(t *testing.T) {
	f := newFakeReleases(t, "v0.3.0")
	h, _ := updateHarness(t, f, "v0.3.0")
	if code := h.run("update"); code != 0 || !strings.Contains(h.stdout.String(), "v0.3.0 is up to date") {
		t.Fatalf("exit %d, stdout %q", code, h.stdout.String())
	}
	h2, target := updateHarness(t, f, "v0.1.0")
	if code := h2.run("update", "--check"); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(h2.stdout.String(), "v0.3.0 is available (you have v0.1.0)") {
		t.Fatalf("stdout = %q", h2.stdout.String())
	}
	if got, _ := os.ReadFile(target); string(got) != "old binary" || f.downloads != 0 {
		t.Fatalf("--check downloaded or replaced the binary")
	}
}

func TestUpdateNoticeOnlyAtTerminalOncePerDay(t *testing.T) {
	f := newFakeReleases(t, "v0.3.0")
	env := map[string]string{"HOMEHOST_RELEASES_URL": f.url + "/releases"}

	quiet := newHarness(t, env)
	quiet.app.version = "v0.2.0"
	quiet.run("machines")
	if f.listings != 0 || strings.Contains(quiet.stderr.String(), "available") {
		t.Fatalf("non-terminal run checked for updates (%d) or printed %q", f.listings, quiet.stderr.String())
	}

	h := newHarness(t, env)
	h.app.version = "v0.2.0"
	h.app.stderrIsTerminal = true
	h.run("machines")
	want := "homehost v0.3.0 is available (you have v0.2.0). Run: homehost update"
	if !strings.Contains(h.stderr.String(), want) || f.listings != 1 {
		t.Fatalf("first run: listings %d, stderr %q", f.listings, h.stderr.String())
	}
	h.stderr.Reset()
	h.run("machines")
	if !strings.Contains(h.stderr.String(), want) || f.listings != 1 {
		t.Fatalf("second run within a day re-checked (%d) or lost the notice: %q", f.listings, h.stderr.String())
	}
	h.app.now = func() time.Time { return time.Now().Add(25 * time.Hour) }
	h.run("machines")
	if f.listings != 2 {
		t.Fatalf("a day later the cache was not refreshed: %d", f.listings)
	}

	optOut := newHarness(t, map[string]string{"HOMEHOST_RELEASES_URL": f.url + "/releases", "HOMEHOST_NO_UPDATE_CHECK": "1"})
	optOut.app.version = "v0.2.0"
	optOut.app.stderrIsTerminal = true
	optOut.run("machines")
	if f.listings != 2 || strings.Contains(optOut.stderr.String(), "available") {
		t.Fatalf("opt-out still checked: %d, %q", f.listings, optOut.stderr.String())
	}
}
