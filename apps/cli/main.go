// Command hh is the homehost agent CLI. It drives machines through the token
// REST API under /api/machines and uses only the Go standard library.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
)

var version = "dev"

const usageText = `hh - homehost agent CLI

Usage:
  hh login [--url https://<panel>]           read a token from stdin and save it
  hh logout                                  forget the saved token
  hh machines                                list machines this token can see
  hh status <machine>                        show one machine
  hh exec [--cwd DIR] [--timeout SEC] <machine> -- <command...>
  hh cat <machine> <path>                    write a file to stdout
  hh put [--mode 0644] <machine> <local-file|-> <path>
  hh start <machine>                         start a stopped machine
  hh stop <machine>                          stop a running machine
  hh mcp-config                              print MCP client setup for this panel
  hh version

exec runs its command with /bin/sh -c on the machine.

Environment: HOMEHOST_URL and HOMEHOST_TOKEN override the saved config.
Config: $XDG_CONFIG_HOME/homehost/cli.json, or ~/.config/homehost/cli.json (mode 0600).
`

type app struct {
	stdin      io.Reader
	stdout     io.Writer
	stderr     io.Writer
	getenv     func(string) string
	configPath string
	version    string
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
		fmt.Fprintf(os.Stderr, "hh: %v\n", err)
		os.Exit(1)
	}
	a := &app{
		stdin:      os.Stdin,
		stdout:     os.Stdout,
		stderr:     os.Stderr,
		getenv:     os.Getenv,
		configPath: path,
		version:    version,
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
	switch cmd, rest := args[0], args[1:]; cmd {
	case "help", "-h", "--help":
		fmt.Fprint(a.stdout, usageText)
		return 0
	case "version", "--version":
		fmt.Fprintln(a.stdout, "hh "+a.version)
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
	default:
		err = usageErr(fmt.Sprintf("unknown command %q; run hh help", cmd))
	}
	if errors.Is(err, flag.ErrHelp) {
		return 0
	}
	if err != nil {
		return a.report(err)
	}
	return code
}

func (a *app) report(err error) int {
	var ce *cliError
	if !errors.As(err, &ce) {
		ce = &cliError{code: "error", msg: err.Error(), exit: 1}
	}
	switch {
	case ce.msg == "":
	case ce.code == "":
		fmt.Fprintf(a.stderr, "hh: %s\n", ce.msg)
	default:
		fmt.Fprintf(a.stderr, "hh: %s (%s)\n", ce.msg, ce.code)
	}
	return ce.exit
}
