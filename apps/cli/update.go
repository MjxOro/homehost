package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	defaultReleasesURL = "https://api.github.com/repos/MjxOro/homehost/releases?per_page=30"
	// CLI releases are tagged cli-vX.Y.Z; the repo's other releases (the
	// panel's vX.Y.Z) are never picked up.
	releaseTagPrefix = "cli-"
	checksumsAsset   = "checksums.txt"
	maxBinaryBytes   = 64 << 20
	updateTimeout    = 2 * time.Minute
)

type releaseAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
}

type release struct {
	Tag        string         `json:"tag_name"`
	Draft      bool           `json:"draft"`
	Prerelease bool           `json:"prerelease"`
	Assets     []releaseAsset `json:"assets"`
}

func (r release) version() string { return strings.TrimPrefix(r.Tag, releaseTagPrefix) }

func (r release) asset(name string) (releaseAsset, bool) {
	for _, a := range r.Assets {
		if a.Name == name {
			return a, true
		}
	}
	return releaseAsset{}, false
}

// parseVersion reads vMAJOR.MINOR.PATCH; anything else (e.g. "dev") is not a
// release version.
func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	parts := strings.Split(strings.TrimPrefix(v, "v"), ".")
	if !strings.HasPrefix(v, "v") || len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// newerThan reports whether candidate is a release newer than current. A
// development build is older than every release.
func newerThan(candidate, current string) bool {
	c, ok := parseVersion(candidate)
	if !ok {
		return false
	}
	cur, ok := parseVersion(current)
	if !ok {
		return true
	}
	for i := range c {
		if c[i] != cur[i] {
			return c[i] > cur[i]
		}
	}
	return false
}

func (a *app) releasesURL() string {
	if v := a.getenv("HOMEHOST_RELEASES_URL"); v != "" {
		return v
	}
	return defaultReleasesURL
}

func (a *app) fetch(url string, limit int64, timeout time.Duration) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "homehost/"+a.version)
	resp, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, url)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, fmt.Errorf("%s is larger than %d bytes", url, limit)
	}
	return raw, nil
}

// latestRelease is the highest published cli-v* release.
func (a *app) latestRelease(timeout time.Duration) (release, error) {
	raw, err := a.fetch(a.releasesURL(), 4<<20, timeout)
	if err != nil {
		return release{}, err
	}
	var all []release
	if err := json.Unmarshal(raw, &all); err != nil {
		return release{}, errors.New("unexpected release listing")
	}
	var best release
	for _, r := range all {
		if r.Draft || r.Prerelease || !strings.HasPrefix(r.Tag, releaseTagPrefix) {
			continue
		}
		if _, ok := parseVersion(r.version()); !ok {
			continue
		}
		if best.Tag == "" || newerThan(r.version(), best.version()) {
			best = r
		}
	}
	if best.Tag == "" {
		return release{}, errors.New("no homehost CLI release is published yet")
	}
	return best, nil
}

func assetName() string { return "homehost-" + runtime.GOOS + "-" + runtime.GOARCH }

func checksumFor(sums []byte, name string) (string, bool) {
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name {
			return strings.ToLower(fields[0]), true
		}
	}
	return "", false
}

func (a *app) cmdUpdate(args []string) (int, error) {
	fl := a.flagSet("update")
	check := fl.Bool("check", false, "only report whether a newer version exists")
	if err := parseFlags(fl, args); err != nil {
		return 0, err
	}
	if err := checkArgs(fl, 0, "homehost update [--check]"); err != nil {
		return 0, err
	}
	latest, err := a.latestRelease(30 * time.Second)
	if err != nil {
		return 0, failure("update_check", "check for updates: "+err.Error())
	}
	a.saveUpdateState(updateState{CheckedAt: a.now(), Latest: latest.version()})
	if !newerThan(latest.version(), a.version) {
		fmt.Fprintf(a.stdout, "homehost %s is up to date\n", a.version)
		return 0, nil
	}
	if *check {
		fmt.Fprintf(a.stdout, "homehost %s is available (you have %s); run: homehost update\n", latest.version(), a.version)
		return 0, nil
	}
	target, err := a.executable()
	if err != nil {
		return 0, failure("update", "find the running binary: "+err.Error())
	}
	if err := a.install(latest, target); err != nil {
		return 0, err
	}
	fmt.Fprintf(a.stdout, "updated homehost %s -> %s (%s)\n", a.version, latest.version(), target)
	return 0, nil
}

// install downloads the release binary for this platform, verifies it against
// checksums.txt, checks it runs, then swaps it over target in one rename.
func (a *app) install(r release, target string) error {
	name := assetName()
	bin, ok := r.asset(name)
	if !ok {
		return failure("update", fmt.Sprintf("release %s has no build for %s/%s", r.Tag, runtime.GOOS, runtime.GOARCH))
	}
	sumsAsset, ok := r.asset(checksumsAsset)
	if !ok {
		return failure("update", "release "+r.Tag+" has no checksums.txt; refusing to install it")
	}
	sums, err := a.fetch(sumsAsset.URL, 1<<20, updateTimeout)
	if err != nil {
		return failure("update", "download checksums: "+err.Error())
	}
	want, ok := checksumFor(sums, name)
	if !ok {
		return failure("update", "checksums.txt does not list "+name)
	}
	payload, err := a.fetch(bin.URL, maxBinaryBytes, updateTimeout)
	if err != nil {
		return failure("update", "download "+name+": "+err.Error())
	}
	got := sha256.Sum256(payload)
	if hex.EncodeToString(got[:]) != want {
		return failure("checksum_mismatch", "downloaded "+name+" does not match checksums.txt; nothing was changed")
	}

	dir := filepath.Dir(target)
	tmp, err := os.CreateTemp(dir, ".homehost-update-*")
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return failure("permission", fmt.Sprintf("cannot write to %s; rerun with sudo or reinstall with the install script", dir))
		}
		return failure("update", "stage update: "+err.Error())
	}
	// Once the rename succeeds the temp name is gone and this Remove fails
	// harmlessly.
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := tmp.Write(payload); err != nil {
		_ = tmp.Close()
		return failure("update", "stage update: "+err.Error())
	}
	if err := tmp.Close(); err != nil {
		return failure("update", "stage update: "+err.Error())
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return failure("update", "stage update: "+err.Error())
	}
	out, err := exec.Command(tmp.Name(), "version").Output()
	if err != nil || !strings.Contains(string(out), r.version()) {
		return failure("update", "the downloaded binary did not run on this machine; nothing was changed")
	}
	if err := os.Rename(tmp.Name(), target); err != nil {
		if errors.Is(err, os.ErrPermission) {
			return failure("permission", fmt.Sprintf("cannot replace %s; rerun with sudo or reinstall with the install script", target))
		}
		return failure("update", "replace binary: "+err.Error())
	}
	return nil
}

func runningExecutable() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(path)
}
