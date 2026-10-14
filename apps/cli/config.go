package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var tokenPattern = regexp.MustCompile(`^hht_[A-Za-z0-9_-]{43}$`)

type config struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

func defaultConfigPath(getenv func(string) string) (string, error) {
	dir := getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("find home directory: %w", err)
		}
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "homehost", "cli.json"), nil
}

func loadConfig(path string) (config, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return config{}, nil
	}
	if err != nil {
		return config{}, failure("config", "read config: "+err.Error())
	}
	var c config
	if err := json.Unmarshal(raw, &c); err != nil {
		return config{}, failure("config", "config file is not valid JSON; run homehost logout")
	}
	return c, nil
}

// saveConfig writes through a temp file so the secret never sits in a
// world-readable file, even when an older file with looser mode exists.
func saveConfig(path string, c config) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return failure("config", "create config dir: "+err.Error())
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return failure("config", "chmod config dir: "+err.Error())
	}
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return failure("config", "encode config: "+err.Error())
	}
	tmp, err := os.CreateTemp(dir, "cli-*.tmp")
	if err != nil {
		return failure("config", "create config: "+err.Error())
	}
	// After a successful rename the temp name is gone, so this Remove
	// is expected to fail and its error is deliberately ignored.
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := tmp.Write(append(raw, '\n')); err != nil {
		_ = tmp.Close()
		return failure("config", "write config: "+err.Error())
	}
	if err := tmp.Close(); err != nil {
		return failure("config", "write config: "+err.Error())
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return failure("config", "save config: "+err.Error())
	}
	return nil
}

func (a *app) settings() (config, error) {
	c, err := loadConfig(a.configPath)
	if err != nil {
		return config{}, err
	}
	if v := a.getenv("HOMEHOST_URL"); v != "" {
		c.URL = v
	}
	if v := a.getenv("HOMEHOST_TOKEN"); v != "" {
		c.Token = v
	}
	return c, nil
}

func (a *app) credentials() (string, string, error) {
	c, err := a.settings()
	if err != nil {
		return "", "", err
	}
	if c.URL == "" || c.Token == "" {
		return "", "", failure("not_logged_in", "not logged in; run homehost login")
	}
	base, err := normalizeURL(c.URL)
	if err != nil {
		return "", "", err
	}
	return base, c.Token, nil
}

func normalizeURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return "", failure("bad_url", "URL must look like https://<panel>")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", failure("bad_url", "URL must not carry credentials, a query or a fragment")
	}
	switch {
	case u.Scheme == "https":
	case u.Scheme == "http" && isDevHost(u.Hostname()):
	default:
		return "", failure("bad_url", "URL must use https (http is only allowed for localhost or private LAN addresses)")
	}
	return strings.TrimRight(u.String(), "/"), nil
}

func isDevHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}
