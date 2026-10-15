package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// newToken builds a random token at test time so no secret-shaped literal lives in the repo.
func newToken(t *testing.T) string {
	t.Helper()
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return "hht_" + base64.RawURLEncoding.EncodeToString(b)
}

func envFunc(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func newServer(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

func rejectAll(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		respond(w, http.StatusInternalServerError, `{"error":"unexpected","code":"unexpected"}`)
	}
}

func serverEnv(srv *httptest.Server, token string) map[string]string {
	return map[string]string{"HOMEHOST_URL": srv.URL, "HOMEHOST_TOKEN": token}
}

func respond(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func readJSON(t *testing.T, r *http.Request, v any) {
	t.Helper()
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		t.Errorf("decode request body: %v", err)
	}
}

type harness struct {
	app        *app
	stdout     *bytes.Buffer
	stderr     *bytes.Buffer
	configPath string
}

func newHarness(t *testing.T, env map[string]string) *harness {
	t.Helper()
	h := &harness{
		stdout:     &bytes.Buffer{},
		stderr:     &bytes.Buffer{},
		configPath: filepath.Join(t.TempDir(), "homehost", "cli.json"),
	}
	h.app = &app{
		stdin:      strings.NewReader(""),
		stdout:     h.stdout,
		stderr:     h.stderr,
		getenv:     envFunc(env),
		configPath: h.configPath,
		version:    "test",
	}
	return h
}

func (h *harness) run(args ...string) int {
	return h.app.run(args)
}

func TestMachinesTable(t *testing.T) {
	tok := newToken(t)
	srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer "+tok {
			t.Errorf("authorization header = %q", got)
		}
		if got := r.Header.Get("User-Agent"); !strings.HasPrefix(got, "homehost/") {
			t.Errorf("user agent = %q", got)
		}
		respond(w, http.StatusOK, `{"machines":[{"id":"1","name":"web-1","kind":"container","planId":"p","status":"running","hostname":"web-1.h.example","capabilities":["exec"]}]}`)
	})
	h := newHarness(t, serverEnv(srv, tok))
	if code := h.run("machines"); code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, h.stderr.String())
	}
	lines := strings.Split(strings.TrimSpace(h.stdout.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines = %q", lines)
	}
	if got := strings.Fields(lines[1]); strings.Join(got, " ") != "web-1 container running web-1.h.example" {
		t.Errorf("row fields = %q", got)
	}
}

func TestExecPropagatesExitCodes(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		body    string
		want    int
		wantOut string
		wantErr string
	}{
		{"success", 200, `{"exitCode":0,"timedOut":false,"stdout":"out\n","stderr":""}`, 0, "out\n", ""},
		{"remote exit 3", 200, `{"exitCode":3,"timedOut":false,"stdout":"","stderr":"boom\n"}`, 3, "", "boom\n"},
		{"timeout", 200, `{"exitCode":null,"timedOut":true,"stdout":"","stderr":""}`, 124, "", ""},
		{"api error", 409, `{"error":"machine is not running","code":"machine_not_running"}`, 1, "", "homehost: machine is not running (machine_not_running)\n"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tok := newToken(t)
			srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
				var body execBody
				readJSON(t, r, &body)
				if body.Command != "ls -la /tmp" {
					t.Errorf("command = %q", body.Command)
				}
				respond(w, tc.status, tc.body)
			})
			h := newHarness(t, serverEnv(srv, tok))
			code := h.run("exec", "web-1", "--", "ls", "-la", "/tmp")
			if code != tc.want {
				t.Errorf("exit = %d, want %d", code, tc.want)
			}
			if h.stdout.String() != tc.wantOut {
				t.Errorf("stdout = %q, want %q", h.stdout.String(), tc.wantOut)
			}
			if h.stderr.String() != tc.wantErr {
				t.Errorf("stderr = %q, want %q", h.stderr.String(), tc.wantErr)
			}
		})
	}
}

func TestExecSendsCwdAndTimeout(t *testing.T) {
	tok := newToken(t)
	srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		var body execBody
		readJSON(t, r, &body)
		if body.Cwd != "/srv" || body.TimeoutSeconds != 5 {
			t.Errorf("body = %+v", body)
		}
		respond(w, http.StatusOK, `{"exitCode":0,"timedOut":false,"stdout":"","stderr":""}`)
	})
	h := newHarness(t, serverEnv(srv, tok))
	if code := h.run("exec", "--cwd", "/srv", "--timeout", "5", "web-1", "--", "make"); code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, h.stderr.String())
	}
}

func TestCatDecodesContent(t *testing.T) {
	binary := []byte{0x00, 0x01, 0xff, 'h', 'i'}
	tests := []struct {
		name     string
		body     string
		want     []byte
		wantWarn bool
	}{
		{
			name:     "base64 binary, truncated",
			body:     `{"path":"/var/data.bin","encoding":"base64","content":"` + base64.StdEncoding.EncodeToString(binary) + `","bytes":5,"truncated":true}`,
			want:     binary,
			wantWarn: true,
		},
		{
			name: "utf8 text",
			body: `{"path":"/etc/motd","encoding":"utf8","content":"hello\n","bytes":6,"truncated":false}`,
			want: []byte("hello\n"),
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tok := newToken(t)
			srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
				var body readFileBody
				readJSON(t, r, &body)
				if body.MaxBytes != fileMaxBytes {
					t.Errorf("maxBytes = %d", body.MaxBytes)
				}
				respond(w, http.StatusOK, tc.body)
			})
			h := newHarness(t, serverEnv(srv, tok))
			path := "/var/data.bin"
			if !tc.wantWarn {
				path = "/etc/motd"
			}
			if code := h.run("cat", "web-1", path); code != 0 {
				t.Fatalf("exit = %d, stderr = %q", code, h.stderr.String())
			}
			if !bytes.Equal(h.stdout.Bytes(), tc.want) {
				t.Errorf("stdout = %x, want %x", h.stdout.Bytes(), tc.want)
			}
			if warned := strings.Contains(h.stderr.String(), "truncated"); warned != tc.wantWarn {
				t.Errorf("truncation warning = %v, stderr = %q", warned, h.stderr.String())
			}
		})
	}
}

func TestPutEncodesFile(t *testing.T) {
	tok := newToken(t)
	data := []byte{0, 1, 2, 3, 'x'}
	var got writeFileBody
	srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		got = writeFileBody{}
		readJSON(t, r, &got)
		respond(w, http.StatusOK, `{"path":"/srv/app.conf","bytes":5}`)
	})
	file := filepath.Join(t.TempDir(), "app.conf")
	if err := writeTestFile(file, data); err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, serverEnv(srv, tok))

	if code := h.run("put", "--mode", "0600", "web-1", file, "/srv/app.conf"); code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, h.stderr.String())
	}
	if got.Encoding != "base64" || got.Path != "/srv/app.conf" || got.Mode != 0o600 {
		t.Errorf("body = %+v", got)
	}
	if decoded, err := base64.StdEncoding.DecodeString(got.Content); err != nil || !bytes.Equal(decoded, data) {
		t.Errorf("content decodes to %x (err %v), want %x", decoded, err, data)
	}

	if code := h.run("put", "web-1", file, "/srv/app.conf"); code != 0 {
		t.Fatalf("default-mode exit = %d", code)
	}
	if got.Mode != 0o644 {
		t.Errorf("default mode = %o, want 644", got.Mode)
	}
}

func TestPutReadsStdin(t *testing.T) {
	tok := newToken(t)
	data := []byte("from stdin")
	var got writeFileBody
	srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		readJSON(t, r, &got)
		respond(w, http.StatusOK, `{"path":"/srv/x","bytes":10}`)
	})
	h := newHarness(t, serverEnv(srv, tok))
	h.app.stdin = bytes.NewReader(data)
	if code := h.run("put", "web-1", "-", "/srv/x"); code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, h.stderr.String())
	}
	if decoded, _ := base64.StdEncoding.DecodeString(got.Content); !bytes.Equal(decoded, data) {
		t.Errorf("content = %q, want %q", decoded, data)
	}
}

func TestPutSizeLimit(t *testing.T) {
	tok := newToken(t)
	t.Run("over limit refused before any request", func(t *testing.T) {
		srv := newServer(t, rejectAll(t))
		file := filepath.Join(t.TempDir(), "big")
		if err := writeTestFile(file, make([]byte, fileMaxBytes+1)); err != nil {
			t.Fatal(err)
		}
		h := newHarness(t, serverEnv(srv, tok))
		if code := h.run("put", "web-1", file, "/srv/big"); code != 1 {
			t.Errorf("exit = %d, want 1", code)
		}
		if !strings.Contains(h.stderr.String(), "file_too_large") {
			t.Errorf("stderr = %q", h.stderr.String())
		}
	})
	t.Run("exact limit accepted", func(t *testing.T) {
		srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
			respond(w, http.StatusOK, `{"path":"/srv/big","bytes":4194304}`)
		})
		file := filepath.Join(t.TempDir(), "edge")
		if err := writeTestFile(file, make([]byte, fileMaxBytes)); err != nil {
			t.Fatal(err)
		}
		h := newHarness(t, serverEnv(srv, tok))
		if code := h.run("put", "web-1", file, "/srv/big"); code != 0 {
			t.Errorf("exit = %d, stderr = %q", code, h.stderr.String())
		}
	})
}

func TestAPIErrorsSurfaceCode(t *testing.T) {
	tok := newToken(t)
	srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		respond(w, http.StatusNotFound, `{"error":"no such machine","code":"not_found"}`)
	})
	h := newHarness(t, serverEnv(srv, tok))
	if code := h.run("status", "ghost"); code != 1 {
		t.Errorf("exit = %d, want 1", code)
	}
	if got := h.stderr.String(); got != "homehost: no such machine (not_found)\n" {
		t.Errorf("stderr = %q", got)
	}
}
