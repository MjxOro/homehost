#!/bin/sh
# Installs the homehost CLI from the newest cli-v* GitHub release:
#
#   curl -fsSL https://homehost.risktozero.sh/install.sh | sh
#
# The binary is checked against the release's checksums.txt before it is
# installed. Re-running the script upgrades in place; after that,
# `homehost update` keeps it current.
#
# Environment:
#   HOMEHOST_INSTALL_DIR  where to put the binary (default ~/.local/bin)
#   HOMEHOST_VERSION      a specific release, e.g. v0.2.0 (default: newest)
#   HOMEHOST_RELEASES_URL release listing (default: the GitHub API)
set -eu

repo="MjxOro/homehost"
releases_url="${HOMEHOST_RELEASES_URL:-https://api.github.com/repos/$repo/releases?per_page=30}"
install_dir="${HOMEHOST_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() {
	printf 'homehost install: %s\n' "$*" >&2
	exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
if command -v sha256sum >/dev/null 2>&1; then
	sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
	sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
	fail "sha256sum or shasum is required to verify the download"
fi

case "$(uname -s)" in
Darwin) os=darwin ;;
Linux) os=linux ;;
*) fail "unsupported OS $(uname -s); builds exist for macOS and Linux" ;;
esac
case "$(uname -m)" in
x86_64 | amd64) arch=amd64 ;;
arm64 | aarch64) arch=arm64 ;;
*) fail "unsupported CPU $(uname -m); builds exist for amd64 and arm64" ;;
esac
asset="homehost-$os-$arch"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

curl -fsSL "$releases_url" -o "$tmp/releases.json" || fail "could not list releases"
# One field per line, so this works whether or not the JSON is pretty-printed.
tr ',{}' '\n\n\n' <"$tmp/releases.json" >"$tmp/fields"

if [ -n "${HOMEHOST_VERSION:-}" ]; then
	tag="cli-$HOMEHOST_VERSION"
else
	tag="$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(cli-v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' "$tmp/fields" |
		awk -F'[v.]' '
			{ v = sprintf("%09d%09d%09d", $2, $3, $4); if (v > best) { best = v; tag = $0 } }
			END { print tag }')"
fi
[ -n "$tag" ] || fail "no homehost CLI release is published yet"

url_for() {
	sed -n "s|.*\"browser_download_url\"[[:space:]]*:[[:space:]]*\"\([^\"]*/$tag/$1\)\".*|\1|p" "$tmp/fields" | head -n 1
}
bin_url="$(url_for "$asset")"
sums_url="$(url_for checksums.txt)"
[ -n "$bin_url" ] || fail "release $tag has no build for $os/$arch"
[ -n "$sums_url" ] || fail "release $tag has no checksums.txt; refusing to install it"

say "Downloading homehost ${tag#cli-} for $os/$arch..."
curl -fsSL "$sums_url" -o "$tmp/checksums.txt" || fail "could not download checksums.txt"
curl -fsSL "$bin_url" -o "$tmp/$asset" || fail "could not download $asset"

want="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$tmp/checksums.txt")"
[ -n "$want" ] || fail "checksums.txt does not list $asset"
got="$(sha256 "$tmp/$asset")"
[ "$got" = "$want" ] || fail "checksum mismatch for $asset; nothing was installed"

chmod 755 "$tmp/$asset"
"$tmp/$asset" version >/dev/null 2>&1 || fail "the downloaded binary does not run on this machine"

mkdir -p "$install_dir" || fail "cannot create $install_dir"
# Stage next to the target, then rename, so a running copy is never half-written.
cp "$tmp/$asset" "$install_dir/.homehost.new" || fail "cannot write to $install_dir (set HOMEHOST_INSTALL_DIR)"
mv -f "$install_dir/.homehost.new" "$install_dir/homehost"

say "Installed $("$install_dir/homehost" version) to $install_dir/homehost"
case ":$PATH:" in
*":$install_dir:"*) ;;
*)
	say ""
	say "$install_dir is not on your PATH. Add this to your shell profile:"
	say "  export PATH=\"$install_dir:\$PATH\""
	;;
esac
say ""
say "Next: create a token on your panel's Agent access page, then run"
say "  echo <token> | homehost login --url https://<your panel>"
say "Later updates: homehost update"
