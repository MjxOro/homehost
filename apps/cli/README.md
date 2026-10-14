# hh

Command-line client for the homehost agent API. Standard library only.

## Build

    go -C apps/cli build -o bin/hh .

Cross-build for darwin/arm64:

    GOOS=darwin GOARCH=arm64 go -C apps/cli build -o bin/hh-darwin-arm64 .

## Login

Create an access token on the Agent access page, then pipe it in. The token is never a command-line argument, so it stays out of shell history:

    printf '%s\n' "$TOKEN" | hh login --url https://panel.example

The token is checked against `GET /api/machines` and saved to `$XDG_CONFIG_HOME/homehost/cli.json` (or `~/.config/homehost/cli.json`), mode 0600 in a 0700 directory. `HOMEHOST_URL` and `HOMEHOST_TOKEN` override the saved values. The URL must be https; plain http is accepted only for localhost and private LAN addresses.

## Commands

    hh logout
    hh machines
    hh status <machine>
    hh exec [--cwd DIR] [--timeout SEC] <machine> -- <command...>
    hh cat <machine> <path>
    hh put [--mode 0644] <machine> <local-file|-> <path>
    hh start <machine>
    hh stop <machine>
    hh mcp-config
    hh version

`exec` joins the arguments after `--` with spaces and runs the result with `/bin/sh -c` on the machine. The exit code is the remote exit code, `124` on timeout, and `1` on API or transport errors. `cat` and `put` are limited to 4 MiB.

`hh mcp-config` prints setup commands that reference `$HOMEHOST_TOKEN`; it never prints the token.

## Tests

    go -C apps/cli test ./...
