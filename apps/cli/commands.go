package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
)

const (
	fileMaxBytes        = 4 << 20
	execDefaultTimeoutS = 60
	execMaxTimeoutS     = 600
	// execSlack keeps the HTTP timeout longer than the worker's own timeout,
	// so a timed-out command comes back as a result rather than a transport error.
	execSlack = 30 * time.Second
)

func (a *app) flagSet(name string) *flag.FlagSet {
	fl := flag.NewFlagSet("hh "+name, flag.ContinueOnError)
	fl.SetOutput(a.stderr)
	return fl
}

func parseFlags(fl *flag.FlagSet, args []string) error {
	if err := fl.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return err
		}
		return &cliError{exit: 2}
	}
	return nil
}

func checkArgs(fl *flag.FlagSet, n int, usage string) error {
	if fl.NArg() != n {
		return usageErr("usage: " + usage)
	}
	return nil
}

func readToken(r io.Reader) (string, error) {
	line, err := bufio.NewReader(r).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", failure("stdin", "read token: "+err.Error())
	}
	return strings.TrimSpace(line), nil
}

func (a *app) cmdLogin(args []string) (int, error) {
	fl := a.flagSet("login")
	target := fl.String("url", "", "panel base URL, e.g. https://panel.example")
	if err := parseFlags(fl, args); err != nil {
		return 0, err
	}
	// The token is never an argument, so it stays out of shell history.
	if fl.NArg() != 0 {
		return 0, usageErr("login takes no arguments; pipe the token on stdin")
	}
	c, err := a.settings()
	if err != nil {
		return 0, err
	}
	if *target == "" {
		*target = c.URL
	}
	if *target == "" {
		return 0, usageErr("pass --url https://<panel>")
	}
	base, err := normalizeURL(*target)
	if err != nil {
		return 0, err
	}
	token, err := readToken(a.stdin)
	if err != nil {
		return 0, err
	}
	if !tokenPattern.MatchString(token) {
		return 0, usageErr("not a homehost access token (expected hht_ followed by 43 URL-safe characters)")
	}
	machines, err := a.newClient(base, token).listMachines()
	if err != nil {
		var ce *cliError
		if errors.As(err, &ce) && ce.code == "unauthorized" {
			return 0, failure("unauthorized", "token rejected; create a new one on the Agent access page")
		}
		return 0, err
	}
	if err := saveConfig(a.configPath, config{URL: base, Token: token}); err != nil {
		return 0, err
	}
	fmt.Fprintf(a.stdout, "logged in to %s (%d machines visible)\n", base, len(machines))
	return 0, nil
}

func (a *app) cmdLogout(args []string) (int, error) {
	fl := a.flagSet("logout")
	if err := parseFlags(fl, args); err != nil {
		return 0, err
	}
	if err := checkArgs(fl, 0, "hh logout"); err != nil {
		return 0, err
	}
	err := os.Remove(a.configPath)
	if errors.Is(err, os.ErrNotExist) {
		fmt.Fprintln(a.stdout, "not logged in")
		return 0, nil
	}
	if err != nil {
		return 0, failure("config", "remove config: "+err.Error())
	}
	fmt.Fprintln(a.stdout, "logged out")
	return 0, nil
}

func (a *app) cmdMachines(args []string) (int, error) {
	fl := a.flagSet("machines")
	if err := parseFlags(fl, args); err != nil {
		return 0, err
	}
	if err := checkArgs(fl, 0, "hh machines"); err != nil {
		return 0, err
	}
	cl, err := a.apiClient()
	if err != nil {
		return 0, err
	}
	machines, err := cl.listMachines()
	if err != nil {
		return 0, err
	}
	tw := tabwriter.NewWriter(a.stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "NAME\tKIND\tSTATUS\tHOSTNAME")
	for _, m := range machines {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", m.Name, m.Kind, m.Status, m.Hostname)
	}
	return 0, tw.Flush()
}

func (a *app) cmdStatus(args []string) (int, error) {
	fl := a.flagSet("status")
	if err := parseFlags(fl, args); err != nil {
		return 0, err
	}
	if err := checkArgs(fl, 1, "hh status <machine>"); err != nil {
		return 0, err
	}
	cl, err := a.apiClient()
	if err != nil {
		return 0, err
	}
	m, err := cl.machine(fl.Arg(0))
	if err != nil {
		return 0, err
	}
	fmt.Fprintf(a.stdout, "name: %s\nid: %s\nkind: %s\nplan: %s\nstatus: %s\nhostname: %s\ncapabilities: %s\n",
		m.Name, m.ID, m.Kind, m.PlanID, m.Status, m.Hostname, strings.Join(m.Capabilities, ", "))
	return 0, nil
}

func (a *app) cmdExec(args []string) (int, error) {
	fl := a.flagSet("exec")
	cwd := fl.String("cwd", "", "working directory on the machine")
	timeout := fl.Int("timeout", execDefaultTimeoutS, "timeout in seconds (1-600)")
	if err := parseFlags(fl, args); err != nil {
		return 0, err
	}
	rest := fl.Args()
	const usage = "hh exec [--cwd DIR] [--timeout SEC] <machine> -- <command...>"
	if len(rest) < 3 || rest[1] != "--" {
		return 0, usageErr("usage: " + usage)
	}
	if *timeout < 1 || *timeout > execMaxTimeoutS {
		return 0, usageErr("--timeout must be between 1 and 600 seconds")
	}
	cl, err := a.apiClient()
	if err != nil {
		return 0, err
	}
	body := execBody{Command: strings.Join(rest[2:], " "), Cwd: *cwd, TimeoutSeconds: *timeout}
	res, err := cl.exec(rest[0], body, time.Duration(*timeout)*time.Second+execSlack)
	if err != nil {
		return 0, err
	}
	if _, err := io.WriteString(a.stdout, res.Stdout); err != nil {
		return 0, err
	}
	if _, err := io.WriteString(a.stderr, res.Stderr); err != nil {
		return 0, err
	}
	if res.StdoutTruncated {
		fmt.Fprintln(a.stderr, "hh: warning: stdout truncated by the server")
	}
	if res.StderrTruncated {
		fmt.Fprintln(a.stderr, "hh: warning: stderr truncated by the server")
	}
	switch {
	case res.TimedOut:
		return 124, nil
	case res.ExitCode != nil:
		return *res.ExitCode, nil
	default:
		return 1, nil
	}
}

func (a *app) cmdCat(args []string) (int, error) {
	fl := a.flagSet("cat")
	if err := parseFlags(fl, args); err != nil {
		return 0, err
	}
	if err := checkArgs(fl, 2, "hh cat <machine> <path>"); err != nil {
		return 0, err
	}
	cl, err := a.apiClient()
	if err != nil {
		return 0, err
	}
	res, err := cl.readFile(fl.Arg(0), readFileBody{Path: fl.Arg(1), MaxBytes: fileMaxBytes})
	if err != nil {
		return 0, err
	}
	data, err := decodeContent(res)
	if err != nil {
		return 0, err
	}
	if _, err := a.stdout.Write(data); err != nil {
		return 0, err
	}
	if res.Truncated {
		fmt.Fprintf(a.stderr, "hh: warning: %s truncated at %d bytes\n", res.Path, fileMaxBytes)
	}
	return 0, nil
}

func decodeContent(res fileReadResult) ([]byte, error) {
	switch res.Encoding {
	case "utf8":
		return []byte(res.Content), nil
	case "base64":
		data, err := base64.StdEncoding.DecodeString(res.Content)
		if err != nil {
			return nil, failure("bad_response", "file content is not valid base64")
		}
		return data, nil
	default:
		return nil, failure("bad_response", "unknown file encoding from server")
	}
}

func (a *app) cmdPut(args []string) (int, error) {
	fl := a.flagSet("put")
	mode := fl.String("mode", "0644", "octal file mode")
	if err := parseFlags(fl, args); err != nil {
		return 0, err
	}
	if err := checkArgs(fl, 3, "hh put [--mode 0644] <machine> <local-file|-> <path>"); err != nil {
		return 0, err
	}
	perm, err := strconv.ParseUint(*mode, 8, 32)
	if err != nil || perm > 0o7777 {
		return 0, usageErr("--mode must be an octal mode such as 0644")
	}
	data, err := a.readLocal(fl.Arg(1))
	if err != nil {
		return 0, err
	}
	cl, err := a.apiClient()
	if err != nil {
		return 0, err
	}
	body := writeFileBody{
		Path:     fl.Arg(2),
		Content:  base64.StdEncoding.EncodeToString(data),
		Encoding: "base64",
		Mode:     int(perm),
	}
	res, err := cl.writeFile(fl.Arg(0), body)
	if err != nil {
		return 0, err
	}
	fmt.Fprintf(a.stdout, "wrote %d bytes to %s\n", res.Bytes, res.Path)
	return 0, nil
}

func (a *app) readLocal(src string) ([]byte, error) {
	var r io.Reader = a.stdin
	if src != "-" {
		f, err := os.Open(src)
		if err != nil {
			return nil, failure("local_file", err.Error())
		}
		defer f.Close()
		r = f
	}
	data, err := io.ReadAll(io.LimitReader(r, fileMaxBytes+1))
	if err != nil {
		return nil, failure("local_file", "read "+src+": "+err.Error())
	}
	if len(data) > fileMaxBytes {
		return nil, failure("file_too_large", fmt.Sprintf("file exceeds the %d byte limit", fileMaxBytes))
	}
	return data, nil
}

func (a *app) cmdPower(action string, args []string) (int, error) {
	fl := a.flagSet(action)
	if err := parseFlags(fl, args); err != nil {
		return 0, err
	}
	if err := checkArgs(fl, 1, "hh "+action+" <machine>"); err != nil {
		return 0, err
	}
	cl, err := a.apiClient()
	if err != nil {
		return 0, err
	}
	m, err := cl.power(fl.Arg(0), action)
	if err != nil {
		return 0, err
	}
	fmt.Fprintf(a.stdout, "%s: %s\n", m.Name, m.Status)
	return 0, nil
}

type mcpServer struct {
	Type    string            `json:"type"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

type mcpConfig struct {
	MCPServers map[string]mcpServer `json:"mcpServers"`
}

// cmdMCPConfig prints setup for this panel. It references $HOMEHOST_TOKEN
// rather than printing the secret.
func (a *app) cmdMCPConfig(args []string) (int, error) {
	fl := a.flagSet("mcp-config")
	if err := parseFlags(fl, args); err != nil {
		return 0, err
	}
	if err := checkArgs(fl, 0, "hh mcp-config"); err != nil {
		return 0, err
	}
	c, err := a.settings()
	if err != nil {
		return 0, err
	}
	if c.URL == "" {
		return 0, failure("not_configured", "no panel URL; run hh login --url https://<panel>")
	}
	base, err := normalizeURL(c.URL)
	if err != nil {
		return 0, err
	}
	mcpURL := base + "/api/mcp"
	fmt.Fprintf(a.stdout, "claude mcp add --transport http homehost %s --header \"Authorization: Bearer $HOMEHOST_TOKEN\"\n\n", mcpURL)
	raw, err := json.MarshalIndent(mcpConfig{MCPServers: map[string]mcpServer{
		"homehost": {
			Type:    "http",
			URL:     mcpURL,
			Headers: map[string]string{"Authorization": "Bearer ${HOMEHOST_TOKEN}"},
		},
	}}, "", "  ")
	if err != nil {
		return 0, failure("encode", "encode mcp config: "+err.Error())
	}
	fmt.Fprintln(a.stdout, string(raw))
	return 0, nil
}
