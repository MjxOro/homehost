package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const (
	updateCheckEvery   = 24 * time.Hour
	updateCheckTimeout = 3 * time.Second
	// defaultNoticeWait bounds how long a finished command waits for a
	// background update check before exiting without it.
	defaultNoticeWait = 1500 * time.Millisecond
)

type updateState struct {
	CheckedAt time.Time `json:"checkedAt"`
	Latest    string    `json:"latest"`
}

func (a *app) updateStatePath() string {
	return filepath.Join(filepath.Dir(a.configPath), "update-check.json")
}

func (a *app) loadUpdateState() updateState {
	var s updateState
	raw, err := os.ReadFile(a.updateStatePath())
	if err == nil {
		_ = json.Unmarshal(raw, &s)
	}
	return s
}

// saveUpdateState is best effort: a read-only config dir only means the next
// run checks again.
func (a *app) saveUpdateState(s updateState) {
	raw, err := json.Marshal(s)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(a.updateStatePath()), 0o700); err != nil {
		return
	}
	_ = os.WriteFile(a.updateStatePath(), raw, 0o600)
}

// noticesEnabled limits the update notice to people at a terminal on a
// release build. Agents and scripts (stderr not a TTY) never trigger the
// network check or see the extra line.
func (a *app) noticesEnabled() bool {
	if !a.stderrIsTerminal || a.getenv("HOMEHOST_NO_UPDATE_CHECK") != "" {
		return false
	}
	_, release := parseVersion(a.version)
	return release
}

// startUpdateNotice refreshes the cached latest version at most once a day,
// in the background, and returns a function that prints the notice once the
// command has finished.
func (a *app) startUpdateNotice() func() {
	if !a.noticesEnabled() {
		return func() {}
	}
	state := a.loadUpdateState()
	done := make(chan updateState, 1)
	if a.now().Sub(state.CheckedAt) >= updateCheckEvery {
		go func() {
			next := updateState{CheckedAt: a.now(), Latest: state.Latest}
			if r, err := a.latestRelease(updateCheckTimeout); err == nil {
				next.Latest = r.version()
			}
			a.saveUpdateState(next)
			done <- next
		}()
	} else {
		done <- state
	}
	return func() {
		select {
		case state = <-done:
		case <-time.After(a.noticeWait):
		}
		if newerThan(state.Latest, a.version) {
			fmt.Fprintf(a.stderr, "\nhomehost %s is available (you have %s). Run: homehost update\n", state.Latest, a.version)
		}
	}
}
