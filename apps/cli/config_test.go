package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeTestFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func TestDefaultConfigPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	got, err := defaultConfigPath(envFunc(nil))
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(home, ".config", "homehost", "cli.json"); got != want {
		t.Errorf("default = %s, want %s", got, want)
	}

	got, err = defaultConfigPath(envFunc(map[string]string{"XDG_CONFIG_HOME": "/xdg"}))
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join("/xdg", "homehost", "cli.json"); got != want {
		t.Errorf("XDG = %s, want %s", got, want)
	}
}

func TestSaveConfigPermissions(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "homehost")
	path := filepath.Join(dir, "cli.json")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := saveConfig(path, config{URL: "https://panel.example", Token: newToken(t)}); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Errorf("file mode = %o, want 600", perm)
	}
	di, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := di.Mode().Perm(); perm != 0o700 {
		t.Errorf("dir mode = %o, want 700", perm)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Errorf("dir has %d entries, want only cli.json", len(entries))
	}
}

func TestSettingsPrecedence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cli.json")
	fileTok, envTok := newToken(t), newToken(t)
	if err := saveConfig(path, config{URL: "https://file.example", Token: fileTok}); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name      string
		env       map[string]string
		wantURL   string
		wantToken string
	}{
		{"file only", nil, "https://file.example", fileTok},
		{"url from env", map[string]string{"HOMEHOST_URL": "https://env.example"}, "https://env.example", fileTok},
		{"both from env", map[string]string{"HOMEHOST_URL": "https://env.example", "HOMEHOST_TOKEN": envTok}, "https://env.example", envTok},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a := &app{configPath: path, getenv: envFunc(tc.env)}
			c, err := a.settings()
			if err != nil {
				t.Fatal(err)
			}
			if c.URL != tc.wantURL || c.Token != tc.wantToken {
				t.Errorf("settings = {%s, token ok=%v}, want {%s, token ok=%v}",
					c.URL, c.Token == tc.wantToken, tc.wantURL, true)
			}
		})
	}
}

func TestCredentialsRequireLogin(t *testing.T) {
	a := &app{configPath: filepath.Join(t.TempDir(), "missing.json"), getenv: envFunc(nil)}
	if _, _, err := a.credentials(); err == nil || err.Error() != "not logged in; run homehost login" {
		t.Errorf("err = %v, want not-logged-in", err)
	}
}

func TestCredentialsRejectPlainHTTPForPublicHost(t *testing.T) {
	a := &app{
		configPath: filepath.Join(t.TempDir(), "missing.json"),
		getenv:     envFunc(map[string]string{"HOMEHOST_URL": "http://panel.example", "HOMEHOST_TOKEN": newToken(t)}),
	}
	if _, _, err := a.credentials(); err == nil {
		t.Error("plain http to a public host was accepted")
	}
}

func TestNormalizeURL(t *testing.T) {
	tests := []struct {
		in   string
		want string
		ok   bool
	}{
		{"https://panel.example/", "https://panel.example", true},
		{"https://panel.example", "https://panel.example", true},
		{"http://localhost:3000", "http://localhost:3000", true},
		{"http://127.0.0.1:3001", "http://127.0.0.1:3001", true},
		{"http://192.168.1.20:3000", "http://192.168.1.20:3000", true},
		{"http://10.0.0.5", "http://10.0.0.5", true},
		{"http://panel.example", "", false},
		{"http://8.8.8.8", "", false},
		{"ftp://panel.example", "", false},
		{"https://", "", false},
		{"https://user:pw@panel.example", "", false},
	}
	for _, tc := range tests {
		got, err := normalizeURL(tc.in)
		if (err == nil) != tc.ok {
			t.Errorf("normalizeURL(%q) err = %v, want ok=%v", tc.in, err, tc.ok)
			continue
		}
		if tc.ok && got != tc.want {
			t.Errorf("normalizeURL(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
