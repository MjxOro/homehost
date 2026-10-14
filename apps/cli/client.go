package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const apiTimeout = 60 * time.Second

const maxResponseBytes = 16 << 20

// Wire shapes mirror packages/shared/src/agent-access.ts.
type agentMachine struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Kind         string   `json:"kind"`
	PlanID       string   `json:"planId"`
	Status       string   `json:"status"`
	Hostname     string   `json:"hostname"`
	Capabilities []string `json:"capabilities"`
}

type machineList struct {
	Machines []agentMachine `json:"machines"`
}

type execBody struct {
	Command        string `json:"command"`
	Cwd            string `json:"cwd,omitempty"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
}

type execResult struct {
	ExitCode        *int   `json:"exitCode"`
	TimedOut        bool   `json:"timedOut"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	StdoutTruncated bool   `json:"stdoutTruncated"`
	StderrTruncated bool   `json:"stderrTruncated"`
}

type readFileBody struct {
	Path     string `json:"path"`
	MaxBytes int    `json:"maxBytes"`
}

type fileReadResult struct {
	Path      string `json:"path"`
	Encoding  string `json:"encoding"`
	Content   string `json:"content"`
	Bytes     int64  `json:"bytes"`
	Truncated bool   `json:"truncated"`
}

type writeFileBody struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
	Mode     int    `json:"mode"`
}

type fileWriteResult struct {
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
}

type powerBody struct {
	Action string `json:"action"`
}

type client struct {
	base  string
	token string
	ua    string
}

func (a *app) newClient(base, token string) *client {
	return &client{base: base, token: token, ua: "homehost/" + a.version}
}

func (a *app) apiClient() (*client, error) {
	base, token, err := a.credentials()
	if err != nil {
		return nil, err
	}
	return a.newClient(base, token), nil
}

// do sends one JSON request. Non-2xx responses become a cliError carrying the
// server's {error, code}; the token is never included in any message.
func (c *client) do(method, path string, body, out any, timeout time.Duration) error {
	var payload io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return failure("encode", "encode request: "+err.Error())
		}
		payload = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, c.base+path, payload)
	if err != nil {
		return failure("transport", "build request: "+err.Error())
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("User-Agent", c.ua)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return failure("transport", "request failed: "+err.Error())
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return failure("transport", "read response: "+err.Error())
	}
	if resp.StatusCode >= 300 {
		return apiFailure(resp.StatusCode, raw)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return failure("bad_response", "unexpected response from server")
	}
	return nil
}

func apiFailure(status int, raw []byte) error {
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	_ = json.Unmarshal(raw, &body)
	code := body.Code
	if code == "" {
		code = fmt.Sprintf("http_%d", status)
	}
	msg := body.Error
	if msg == "" {
		msg = fmt.Sprintf("request failed with HTTP %d", status)
	}
	return failure(code, msg)
}

func machinePath(name string) string {
	return "/api/machines/" + url.PathEscape(name)
}

func (c *client) listMachines() ([]agentMachine, error) {
	var out machineList
	err := c.do(http.MethodGet, "/api/machines", nil, &out, apiTimeout)
	return out.Machines, err
}

func (c *client) machine(name string) (agentMachine, error) {
	var m agentMachine
	err := c.do(http.MethodGet, machinePath(name), nil, &m, apiTimeout)
	return m, err
}

func (c *client) exec(name string, body execBody, timeout time.Duration) (execResult, error) {
	var res execResult
	err := c.do(http.MethodPost, machinePath(name)+"/exec", body, &res, timeout)
	return res, err
}

func (c *client) readFile(name string, body readFileBody) (fileReadResult, error) {
	var res fileReadResult
	err := c.do(http.MethodPost, machinePath(name)+"/files/read", body, &res, apiTimeout)
	return res, err
}

func (c *client) writeFile(name string, body writeFileBody) (fileWriteResult, error) {
	var res fileWriteResult
	err := c.do(http.MethodPost, machinePath(name)+"/files/write", body, &res, apiTimeout)
	return res, err
}

func (c *client) power(name, action string) (agentMachine, error) {
	var m agentMachine
	err := c.do(http.MethodPost, machinePath(name)+"/power", powerBody{Action: action}, &m, apiTimeout)
	return m, err
}
