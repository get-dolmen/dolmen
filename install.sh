#!/bin/sh
# Dolmen installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/get-dolmen/dolmen/main/install.sh | sh
#   ./install.sh --version v0.1.0
#
# Downloads a release from GitHub, verifies its SHA-256 checksum and installs
# Dolmen.app (macOS) or the dolmen binary (Linux).

set -eu

REPO="${DOLMEN_REPO:-get-dolmen/dolmen}"
VERSION="${DOLMEN_VERSION:-}"
INSTALL_DIR="${DOLMEN_INSTALL_DIR:-}"
VERIFY=1

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Install Dolmen from GitHub releases on macOS or Linux.

Options:
  -v, --version VERSION  Release to install (default: the latest, e.g. v0.1.0)
      --dir DIR          Installation directory
                           macOS: defaults to /Applications, or ~/Applications
                                  when /Applications is not writable
                           Linux: defaults to ~/.local/bin
      --no-verify        Skip SHA-256 checksum verification
  -h, --help             Show this help

Environment:
  DOLMEN_VERSION      Same as --version
  DOLMEN_INSTALL_DIR  Same as --dir
  DOLMEN_REPO         GitHub repository (default: get-dolmen/dolmen)

Windows: download the setup .exe from
https://github.com/get-dolmen/dolmen/releases/latest
EOF
}

die() {
  printf 'dolmen: %s\n' "$*" >&2
  exit 1
}

need_value() {
  [ "$#" -ge 2 ] || die "$1 needs a value"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -v|--version)
      need_value "$@"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#*=}"
      shift
      ;;
    --dir|--prefix)
      need_value "$@"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --dir=*|--prefix=*)
      INSTALL_DIR="${1#*=}"
      shift
      ;;
    --no-verify)
      VERIFY=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option '$1' (try --help)"
      ;;
  esac
done

OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Darwin) ;;
  Linux) ;;
  *)
    die "unsupported operating system '$OS'; download the Windows installer from https://github.com/$REPO/releases/latest"
    ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) die "unsupported architecture '$ARCH'" ;;
esac

command -v curl >/dev/null 2>&1 || die "curl is required"

if [ "$OS" = Darwin ]; then
  command -v unzip >/dev/null 2>&1 || die "unzip is required"
else
  command -v tar >/dev/null 2>&1 || die "tar is required"
  [ "$ARCH" = amd64 ] || die "no Linux $ARCH build is published; only linux-amd64 is available"
fi

TMPDIR_BASE="${TMPDIR:-/tmp}"
WORKDIR=$(mktemp -d "$TMPDIR_BASE/dolmen-install.XXXXXX") || die "could not create a temporary directory"
trap 'rm -rf "$WORKDIR"' EXIT

download() {
  curl -fL --retry 3 --retry-delay 2 --proto '=https' --tlsv1.2 -o "$2" "$1"
}

if [ -z "$VERSION" ]; then
  printf 'Looking up the latest Dolmen release...\n'
  download "https://api.github.com/repos/$REPO/releases/latest" "$WORKDIR/latest.json" ||
    die "could not query the latest release; pass --version or see https://github.com/$REPO/releases"
  VERSION=$(sed -n 's/^[[:space:]]*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$WORKDIR/latest.json" | head -n 1)
  [ -n "$VERSION" ] || die "could not read the latest release tag; pass --version or see https://github.com/$REPO/releases"
else
  case "$VERSION" in
    v*) ;;
    *) VERSION="v$VERSION" ;;
  esac
fi

case "$OS" in
  Darwin) ASSET="dolmen-$VERSION-macos-universal.zip" ;;
  Linux) ASSET="dolmen-$VERSION-linux-amd64.tar.gz" ;;
esac

URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"

printf 'Downloading %s...\n' "$URL"
download "$URL" "$WORKDIR/$ASSET" || die "could not download $URL"

if [ "$VERIFY" -eq 1 ]; then
  if download "https://github.com/$REPO/releases/download/$VERSION/SHA256SUMS.txt" "$WORKDIR/SHA256SUMS.txt" 2>/dev/null; then
    EXPECTED=$(awk -v file="$ASSET" '$2 == file { print $1; exit }' "$WORKDIR/SHA256SUMS.txt")
    [ -n "$EXPECTED" ] || die "$ASSET is not listed in SHA256SUMS.txt"
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL=$(sha256sum "$WORKDIR/$ASSET" | awk '{ print $1 }')
    elif command -v shasum >/dev/null 2>&1; then
      ACTUAL=$(shasum -a 256 "$WORKDIR/$ASSET" | awk '{ print $1 }')
    else
      die "sha256sum or shasum is required to verify the download (use --no-verify to skip)"
    fi
    [ "$ACTUAL" = "$EXPECTED" ] || die "checksum mismatch for $ASSET"
    printf 'Checksum verified.\n'
  else
    printf 'Warning: SHA256SUMS.txt is unavailable; skipping checksum verification.\n' >&2
  fi
fi

if [ "$OS" = Darwin ]; then
  unzip -q "$WORKDIR/$ASSET" -d "$WORKDIR" || die "could not extract $ASSET"
  APP_SOURCE=$(find "$WORKDIR" -maxdepth 1 -type d -name '*.app' | head -n 1)
  [ -n "$APP_SOURCE" ] || die "no .app bundle found in $ASSET"

  if [ -z "$INSTALL_DIR" ]; then
    if [ -w /Applications ]; then
      INSTALL_DIR=/Applications
    else
      INSTALL_DIR="$HOME/Applications"
    fi
  fi
  mkdir -p "$INSTALL_DIR"
  APP_NAME=$(basename "$APP_SOURCE")
  APP_TARGET="$INSTALL_DIR/$APP_NAME"

  printf 'Installing %s...\n' "$APP_TARGET"
  rm -rf "$APP_TARGET"
  if command -v ditto >/dev/null 2>&1; then
    ditto "$APP_SOURCE" "$APP_TARGET"
  else
    cp -R "$APP_SOURCE" "$APP_TARGET"
  fi
  # The release is not signed or notarised, so clear the quarantine flag.
  xattr -dr com.apple.quarantine "$APP_TARGET" 2>/dev/null || true

  printf '\nDolmen %s installed at %s\n' "$VERSION" "$APP_TARGET"
  printf 'Open it from Finder or with: open "%s"\n' "$APP_TARGET"
  exit 0
fi

if [ -z "$INSTALL_DIR" ]; then
  INSTALL_DIR="$HOME/.local/bin"
fi
mkdir -p "$INSTALL_DIR"

printf 'Installing dolmen in %s...\n' "$INSTALL_DIR"
tar -xzf "$WORKDIR/$ASSET" -C "$WORKDIR" dolmen || die "could not extract $ASSET"
install -m 755 "$WORKDIR/dolmen" "$INSTALL_DIR/dolmen"

printf '\nDolmen %s installed at %s/dolmen\n' "$VERSION" "$INSTALL_DIR"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf 'Note: %s is not on your PATH. Add it with:\n  export PATH="%s:$PATH"\n' "$INSTALL_DIR" "$INSTALL_DIR" ;;
esac
