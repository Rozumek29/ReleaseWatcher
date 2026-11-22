#!/bin/sh
# Removes the ReleaseWatcher systemd service installed by install.sh. Run as root inside the machine/LXC:
#
#   sh uninstall.sh            # service + executable; keeps the data and the configuration
#   PURGE=1 sh uninstall.sh    # also the data (database, encryption key), the configuration, the logs and the user
#
# `releasewatcher --uninstall [--purge]` runs this script.
set -eu

APP_DIR=/opt/releasewatcher
DATA_DIR=/var/lib/releasewatcher
CONF_DIR=/etc/releasewatcher
LOG_DIR=/var/log/releasewatcher
UNIT=/etc/systemd/system/releasewatcher.service

say() { printf '\033[1;34m»\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root."
command -v systemctl >/dev/null 2>&1 || die "systemd is required."

if [ -f "$UNIT" ]; then
  say "Stopping and removing the service"
  systemctl disable --now releasewatcher >/dev/null 2>&1 || true
  rm -f "$UNIT"
  systemctl daemon-reload
fi

if [ -d "$APP_DIR" ]; then
  say "Removing $APP_DIR"
  rm -rf "$APP_DIR"
fi

if [ "${PURGE:-0}" = 1 ]; then
  say "Removing the data, the configuration and the logs"
  rm -rf "$DATA_DIR" "$CONF_DIR" "$LOG_DIR"
  if id releasewatcher >/dev/null 2>&1; then
    say "Removing the system user releasewatcher"
    userdel releasewatcher 2>/dev/null || true
  fi
  printf '\n\033[1;32m✓ ReleaseWatcher was removed completely.\033[0m\n'
else
  printf '\n\033[1;32m✓ ReleaseWatcher was removed.\033[0m\n'
  printf '  Kept: %s (database, encryption key) and %s (configuration).\n' "$DATA_DIR" "$CONF_DIR"
  printf '  Install again to continue with them, or remove them: rm -rf %s %s %s && userdel releasewatcher\n' \
    "$DATA_DIR" "$CONF_DIR" "$LOG_DIR"
fi
