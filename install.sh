#!/bin/sh
# Install rpt.
#
#   curl -fsSL https://raw.githubusercontent.com/KlyneChrysler/rpt/main/install.sh | sh
#
# You are about to pipe a script from the internet into a shell. Read it first:
# it is short on purpose, and everything it does is below. It downloads a
# published release tarball, checks it against the SHA-256 recorded in that
# release, and installs it with npm. It writes nothing outside npm's global
# prefix and a temporary directory it removes on exit.
#
# Pin a version with RPT_VERSION, or point at a fork with RPT_REPO.
set -eu

REPO="${RPT_REPO:-KlyneChrysler/rpt}"
VERSION="${RPT_VERSION:-latest}"
MIN_NODE_MAJOR=22

say() { printf 'rpt: %s\n' "$1"; }
die() { printf 'rpt: %s\n' "$1" >&2; exit 1; }

need() {
	command -v "$1" >/dev/null 2>&1 || die "$1 is required and was not found on PATH"
}

need node
need npm
need curl

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
	die "node $MIN_NODE_MAJOR or newer is required, found $(node --version)"
fi

if [ "$VERSION" = "latest" ]; then
	VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
		| sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
	[ -n "$VERSION" ] || die "could not determine the latest release of $REPO"
fi

BASE="https://github.com/$REPO/releases/download/$VERSION"
TARBALL="rpt-cli-${VERSION#v}.tgz"

workdir=$(mktemp -d)
# Runs on every exit path, including the die calls above this point in the
# script's life and any signal: an install that fails should leave nothing.
trap 'rm -rf "$workdir"' EXIT INT TERM

say "downloading $TARBALL from $VERSION"
curl -fsSL "$BASE/$TARBALL" -o "$workdir/$TARBALL" \
	|| die "could not download $BASE/$TARBALL"

# The checksum is published in the release alongside the tarball. Verifying it
# is the difference between trusting the transport and trusting the artefact.
if curl -fsSL "$BASE/$TARBALL.sha256" -o "$workdir/$TARBALL.sha256" 2>/dev/null; then
	expected=$(cut -d' ' -f1 < "$workdir/$TARBALL.sha256")
	if command -v shasum >/dev/null 2>&1; then
		actual=$(shasum -a 256 "$workdir/$TARBALL" | cut -d' ' -f1)
	elif command -v sha256sum >/dev/null 2>&1; then
		actual=$(sha256sum "$workdir/$TARBALL" | cut -d' ' -f1)
	else
		actual=""
		say "no shasum or sha256sum found, skipping checksum verification"
	fi
	if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
		die "checksum mismatch: expected $expected, got $actual"
	fi
	[ -n "$actual" ] && say "checksum verified"
else
	say "no published checksum for $VERSION, skipping verification"
fi

say "installing"
npm install -g "$workdir/$TARBALL" >/dev/null

command -v rpt >/dev/null 2>&1 || die "installed, but rpt is not on PATH - check npm's global bin directory"
say "installed rpt $(rpt --version)"
say 'next: cd into a git repository and run "rpt init"'
