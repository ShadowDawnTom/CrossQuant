#!/bin/bash
# Gate CrossEx macOS uninstaller. User data is preserved unless --purge is explicit.

set -euo pipefail
umask 077

ROOT="${GCT_INSTALL_ROOT:-$HOME/Library/Application Support/Gate CrossEx}"
MARKER="$ROOT/.gate-crossex-install-root"
LABEL="com.yourquantguy.gate-crossex"
PLIST="${GCT_LAUNCH_AGENT_PATH:-$HOME/Library/LaunchAgents/$LABEL.plist}"
LAUNCHER_APP="${GCT_LAUNCHER_APP_PATH:-$HOME/Applications/Gate CrossEx.app}"
SKIP_SERVICE="${GCT_SKIP_SERVICE:-0}"
PURGE=0
case "${1:-}" in
  '') ;;
  --purge) PURGE=1 ;;
  *) echo "Usage: uninstall.sh [--purge]" >&2; exit 2 ;;
esac
[ $# -le 1 ] || { echo "Usage: uninstall.sh [--purge]" >&2; exit 2; }

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this uninstaller currently supports macOS only."
[ "$(id -u)" -ne 0 ] || fail "run without sudo."
case "$ROOT" in ''|/|"$HOME"|"$HOME"/) fail "unsafe installation root: $ROOT" ;; esac
case "$PLIST" in ''|/|"$HOME"|"$HOME"/) fail "unsafe LaunchAgent path: $PLIST" ;; esac
[ "$(basename "$PLIST")" = "$LABEL.plist" ] || fail "the LaunchAgent filename must be $LABEL.plist."
case "$LAUNCHER_APP" in ''|/|"$HOME"|"$HOME"/) fail "unsafe launcher path: $LAUNCHER_APP" ;; esac
case "$LAUNCHER_APP" in *.app) ;; *) fail "the launcher path must end in .app." ;; esac
if [ "$PURGE" -eq 1 ]; then
  [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "Gate CrossEx install root v1" ] \
    || fail "refusing to purge an unrecognized installation root: $ROOT"
fi

if [ "$SKIP_SERVICE" != "1" ] && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "Stopping Gate CrossEx safely..."
  launchctl bootout "gui/$(id -u)/$LABEL" || fail "the backend could not be stopped; nothing was removed."
fi

lock="$ROOT/data/backend.lock"
if [ -f "$lock" ]; then
  pid="$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$lock" | head -1)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    command_line="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$command_line" in
      *"$ROOT/versions/"*|*"$ROOT/current/"*)
        for _ in $(seq 1 140); do
          kill -0 "$pid" 2>/dev/null || break
          sleep 0.25
        done
        kill -0 "$pid" 2>/dev/null && fail "the backend is still shutting down; no files were removed."
        ;;
    esac
  fi
fi

rm -f "$PLIST"
rm -rf "$LAUNCHER_APP"

if [ "$PURGE" -eq 1 ]; then
  rm -rf "$ROOT"
  echo "Gate CrossEx and all local data, credentials, logs, and backups were removed."
else
  rm -f "$ROOT/current"
  rm -rf "$ROOT/versions" "$ROOT/bin"
  echo "Gate CrossEx was uninstalled."
  echo "Database, credentials, logs, and backups were preserved under: $ROOT"
  echo "Run uninstall.sh --purge only if you intentionally want to delete them."
fi
