// Command homehost is the agent CLI for homehost machines. It drives
// machines through the token REST API under /api/machines and uses only the
// Go standard library.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"
)

var version = "dev"

const usageText = `homehost - agent CLI for homehost machines

Usage:
  homehost login [--url https://<panel>]           read a token from stdin and save it
  homehost logout                                  forget the saved token
  homehost machines                                list machines this token can see
  homehost status <machine>                        show one machine
  homehost exec [--cwd DIR] [--timeout SEC] <machine> -- <command...>
  homehost cat <machine> <path>                    write a file to stdout
  homehost put [--mode 0644] <machine> <local-file|-> <path>
  homehost start <machine>                         start a stopped machine
  homehost stop <machine>                          stop a running machine
  homehost mcp-config                              print MCP client setup for this panel
  homehost update [--check]                        install the latest release in place
  homehost version

exec runs its command with /bin/sh -c on the machine.

Environment: HOMEHOST_URL and HOMEHOST_TOKEN override the saved config.
At a terminal, homehost checks for a new release once a day and says so;
set HOMEHOST_NO_UPDATE_CHECK=1 to turn that off.
Config: $XDG_CONFIG_HOME/homehost/cli.json, or ~/.config/homehost/cli.json (mode 0600).
`

type app struct {
	stdin      io.Reader
	stdout     io.Writer
	stderr     io.Writer
	getenv     func(string) string
	configPath string
	version    string
	// stderrIsTerminal gates the daily update notice to interactive use.
	stderrIsTerminal bool
	noticeWait       time.Duration
	now              func() time.Time
	executable       func() (string, error)
}

type cliError struct {
	code string
	msg  string
	exit int
}

func (e *cliError) Error() string { return e.msg }

func usageErr(msg string) error { return &cliError{msg: msg, exit: 2} }

func failure(code, msg string) error { return &cliError{code: code, msg: msg, exit: 1} }

func main() {
	path, err := defaultConfigPath(os.Getenv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "homehost: %v\n", err)
		os.Exit(1)
	}
	a := &app{
		stdin:            os.Stdin,
		stdout:           os.Stdout,
		stderr:           os.Stderr,
		getenv:           os.Getenv,
		configPath:       path,
		version:          version,
		stderrIsTerminal: isTerminal(os.Stderr),
		noticeWait:       defaultNoticeWait,
		now:              time.Now,
		executable:       runningExecutable,
	}
	os.Exit(a.run(os.Args[1:]))
}

func (a *app) run(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(a.stderr, usageText)
		return 2
	}
	var (
		code int
		err  error
	)
	switch args[0] {
	case "help", "-h", "--help", "version", "--version", "update":
	default:
		defer a.startUpdateNotice()()
	}
	switch cmd, rest := args[0], args[1:]; cmd {
	case "help", "-h", "--help":
		fmt.Fprint(a.stdout, usageText)
		return 0
	case "version", "--version":
		fmt.Fprintln(a.stdout, "homehost "+a.version)
		return 0
	case "login":
		code, err = a.cmdLogin(rest)
	case "logout":
		code, err = a.cmdLogout(rest)
	case "machines":
		code, err = a.cmdMachines(rest)
	case "status":
		code, err = a.cmdStatus(rest)
	case "exec":
		code, err = a.cmdExec(rest)
	case "cat":
		code, err = a.cmdCat(rest)
	case "put":
		code, err = a.cmdPut(rest)
	case "start":
		code, err = a.cmdPower("start", rest)
	case "stop":
		code, err = a.cmdPower("stop", rest)
	case "mcp-config":
		code, err = a.cmdMCPConfig(rest)
	case "update":
		code, err = a.cmdUpdate(rest)
	default:
		err = usageErr(fmt.Sprintf("unknown command %q; run homehost help", cmd))
	}
	if errors.Is(err, flag.ErrHelp) {
		return 0
	}
	if err != nil {
		return a.report(err)
	}
	return code
}

func isTerminal(f *os.File) bool {
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func (a *app) report(err error) int {
	var ce *cliError
	if !errors.As(err, &ce) {
		ce = &cliError{code: "error", msg: err.Error(), exit: 1}
	}
	switch {
	case ce.msg == "":
	case ce.code == "":
		fmt.Fprintf(a.stderr, "homehost: %s\n", ce.msg)
	default:
		fmt.Fprintf(a.stderr, "homehost: %s (%s)\n", ce.msg, ce.code)
	}
	return ce.exit
}
