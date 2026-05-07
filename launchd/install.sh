#!/usr/bin/env bash
# Install / uninstall the paperclip-dev launchd agent.
#
# Usage:
#   ./launchd/install.sh install   — bootstrap + kickstart
#   ./launchd/install.sh uninstall — bootout + remove plist
#   ./launchd/install.sh status    — show current state
#   ./launchd/install.sh restart   — kickstart-restart
#   ./launchd/install.sh logs      — tail log files

set -euo pipefail

LABEL="com.everpretty.paperclip-dev"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC_PLIST="${HERE}/${LABEL}.plist"
DEST_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOGS_DIR="${HERE}/../_logs"

cmd="${1:-status}"

case "$cmd" in
  install)
    [[ -f "$SRC_PLIST" ]] || { echo "missing $SRC_PLIST"; exit 1; }
    mkdir -p "${HOME}/Library/LaunchAgents" "$LOGS_DIR"
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    cp -f "$SRC_PLIST" "$DEST_PLIST"
    launchctl bootstrap "gui/$(id -u)" "$DEST_PLIST"
    launchctl kickstart -k "gui/$(id -u)/${LABEL}"
    echo "[install] bootstrapped + kickstarted ${LABEL}"
    sleep 5
    "$0" status
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null && echo "[uninstall] booted out" || echo "[uninstall] was not loaded"
    rm -f "$DEST_PLIST" && echo "[uninstall] removed $DEST_PLIST" || true
    ;;
  status)
    if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
      launchctl print "gui/$(id -u)/${LABEL}" | sed -n '/state =/p; /pid =/p; /last exit code =/p; /program =/p'
    else
      echo "[status] ${LABEL}: NOT loaded"
    fi
    ;;
  restart)
    launchctl kickstart -k "gui/$(id -u)/${LABEL}"
    echo "[restart] kickstarted"
    sleep 5
    "$0" status
    ;;
  logs)
    echo "=== stdout (last 30) ==="
    tail -n 30 "$LOGS_DIR/paperclip-dev.out.log" 2>/dev/null || echo "(no stdout log yet)"
    echo "=== stderr (last 30) ==="
    tail -n 30 "$LOGS_DIR/paperclip-dev.err.log" 2>/dev/null || echo "(no stderr log yet)"
    ;;
  *)
    echo "usage: $0 {install|uninstall|status|restart|logs}"
    exit 1
    ;;
esac
