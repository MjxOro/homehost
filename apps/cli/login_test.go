package main

import (
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestLoginRejectsTokenArgument(t *testing.T) {
	h := newHarness(t, nil)
	if code := h.run("login", newToken(t)); code != 2 {
		t.Errorf("exit = %d, want 2", code)
	}
	if !strings.Contains(h.stderr.String(), "pipe the token on stdin") {
		t.Errorf("stderr = %q", h.stderr.String())
	}
}

func TestLoginRejectsMalformedToken(t *testing.T) {
	good := newToken(t)
	bad := []string{
		"",
		"hht_short",
		"xoxb-" + good[4:],
		good + "x",
		"hht_" + strings.Repeat("+", 43),
	}
	for _, tok := range bad {
		srv := newServer(t, rejectAll(t))
		h := newHarness(t, nil)
		h.app.stdin = strings.NewReader(tok + "\n")
		if code := h.run("login", "--url", srv.URL); code != 2 {
			t.Errorf("token %q: exit = %d, want 2", tok[:min(len(tok), 8)], code)
		}
	}
}

func TestLoginVerifiesAndSavesToken(t *testing.T) {
	tok := newToken(t)
	srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/machines" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+tok {
			t.Errorf("authorization header = %q", got)
		}
		if got := r.Header.Get("User-Agent"); !strings.HasPrefix(got, "hh/") {
			t.Errorf("user agent = %q", got)
		}
		respond(w, http.StatusOK, `{"machines":[]}`)
	})
	h := newHarness(t, nil)
	h.app.stdin = strings.NewReader(tok + "\n")
	if code := h.run("login", "--url", srv.URL); code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, h.stderr.String())
	}
	c, err := loadConfig(h.configPath)
	if err != nil {
		t.Fatal(err)
	}
	if c.URL != srv.URL || c.Token != tok {
		t.Errorf("saved config = {%s, token ok=%v}", c.URL, c.Token == tok)
	}
	if strings.Contains(h.stdout.String(), tok) || strings.Contains(h.stderr.String(), tok) {
		t.Error("token was printed")
	}
}

func TestLoginRejectedTokenWritesNothing(t *testing.T) {
	srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		respond(w, http.StatusUnauthorized, `{"error":"unauthorized","code":"unauthorized"}`)
	})
	h := newHarness(t, nil)
	h.app.stdin = strings.NewReader(newToken(t) + "\n")
	if code := h.run("login", "--url", srv.URL); code != 1 {
		t.Errorf("exit = %d, want 1", code)
	}
	if !strings.Contains(h.stderr.String(), "token rejected") {
		t.Errorf("stderr = %q", h.stderr.String())
	}
	if _, err := os.Stat(h.configPath); !os.IsNotExist(err) {
		t.Errorf("config written after rejection: %v", err)
	}
}
