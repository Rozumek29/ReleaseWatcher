#!/bin/sh
# Installs or updates ReleaseWatcher as a systemd service. Run as root inside the target machine/LXC:
#
#   sh install.sh [directory]
#
# The directory (default: the script's directory) must contain `releasewatcher-linux-x64` and
# `releasewatcher.service`; optionally `.env.example` (template for the first configuration) and
# `releasewatcher.db` (database to start with – used only when none exists yet, or with FORCE_DB=1).
# Safe to run again: it replaces the executable (keeping the previous one for a rollback), keeps the configuration
# and the data, and restarts the service. `scripts/deploy-lxc.ts` runs it for you from your computer.
set -eu

SRC=${1:-$(dirname "$0")}
APP_DIR=/opt/releasewatcher
DATA_DIR=/var/lib/releasewatcher
CONF_DIR=/etc/releasewatcher
ENV_FILE=$CONF_DIR/releasewatcher.env
UNIT=/etc/systemd/system/releasewatcher.service

say() { printf '\033[1;34m»\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root."
[ -f "$SRC/releasewatcher-linux-x64" ] || die "$SRC/releasewatcher-linux-x64 not found."
[ -f "$SRC/releasewatcher.service" ] || die "$SRC/releasewatcher.service not found."
command -v systemctl >/dev/null 2>&1 || die "systemd is required."

if ! command -v ssh >/dev/null 2>&1; then
  say "Installing the OpenSSH client"
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-client ca-certificates >/dev/null
  else
    die "Install the OpenSSH client (ssh) first."
  fi
fi

if ! id releasewatcher >/dev/null 2>&1; then
  say "Creating the system user releasewatcher"
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin releasewatcher
fi
install -d -o releasewatcher -g releasewatcher -m 750 "$DATA_DIR"
install -d -m 755 "$APP_DIR"
install -d -o root -g releasewatcher -m 750 "$CONF_DIR"

if [ -f "$APP_DIR/releasewatcher" ]; then
  say "Updating the executable (previous one kept as $APP_DIR/releasewatcher.previous)"
  cp -p "$APP_DIR/releasewatcher" "$APP_DIR/releasewatcher.previous"
else
  say "Installing the executable"
fi
install -m 755 "$SRC/releasewatcher-linux-x64" "$APP_DIR/releasewatcher.new"
mv -f "$APP_DIR/releasewatcher.new" "$APP_DIR/releasewatcher"

install -m 644 "$SRC/releasewatcher.service" "$UNIT"

PASSWORD=''
if [ ! -f "$ENV_FILE" ]; then
  say "Creating $ENV_FILE with Basic auth (user: admin)"
  # 18 random bytes → 24 base64 characters, minus the non-alphanumeric ones. No `tr </dev/urandom | head`:
  # head closing the pipe early makes tr fail with "Broken pipe" when SIGPIPE is ignored (e.g. under pct exec).
  PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '+/=\n')
  if [ -f "$SRC/.env.example" ]; then
    sed -e "s/^BASIC_AUTH_USERNAME=.*/BASIC_AUTH_USERNAME=admin/" \
        -e "s/^BASIC_AUTH_PASSWORD=.*/BASIC_AUTH_PASSWORD=$PASSWORD/" "$SRC/.env.example" >"$ENV_FILE"
  fi
  grep -q '^BASIC_AUTH_USERNAME=admin' "$ENV_FILE" 2>/dev/null || printf 'BASIC_AUTH_USERNAME=admin\n' >>"$ENV_FILE"
  grep -q "^BASIC_AUTH_PASSWORD=$PASSWORD" "$ENV_FILE" || printf 'BASIC_AUTH_PASSWORD=%s\n' "$PASSWORD" >>"$ENV_FILE"
  chown root:releasewatcher "$ENV_FILE"
  chmod 640 "$ENV_FILE"
fi

if [ -f "$SRC/releasewatcher.db" ]; then
  if [ ! -f "$DATA_DIR/releasewatcher.db" ] || [ "${FORCE_DB:-0}" = 1 ]; then
    say "Installing the provided database"
    systemctl stop releasewatcher 2>/dev/null || true
    rm -f "$DATA_DIR/releasewatcher.db" "$DATA_DIR/releasewatcher.db-wal" "$DATA_DIR/releasewatcher.db-shm"
    install -m 640 -o releasewatcher -g releasewatcher "$SRC/releasewatcher.db" "$DATA_DIR/releasewatcher.db"
  else
    say "A database already exists – the provided one is ignored (FORCE_DB=1 replaces it)"
  fi
fi

say "Starting the service"
systemctl daemon-reload
systemctl enable releasewatcher >/dev/null 2>&1
systemctl restart releasewatcher

# Give it a moment to fail fast (bad configuration, missing nesting for the sandboxing, …).
sleep 3
if ! systemctl is-active --quiet releasewatcher; then
  journalctl -u releasewatcher --no-pager -n 30 >&2 || true
  if journalctl -u releasewatcher --no-pager -n 30 2>/dev/null | grep -q '226/NAMESPACE'; then
    die "The service cannot sandbox itself: enable Options → Features → Nesting for this LXC and run again."
  fi
  die "The service did not start – see the log above."
fi

PORT=$(sed -n 's/^PORT=\([0-9][0-9]*\).*/\1/p' "$ENV_FILE" 2>/dev/null | tail -n 1)
IP=$(hostname -I 2>/dev/null | awk '{ print $1 }')
printf '\n\033[1;32m✓ ReleaseWatcher is running:\033[0m http://%s:%s\n' "${IP:-<this machine>}" "${PORT:-8080}"
if [ -n "$PASSWORD" ]; then
  printf '  Login: \033[1madmin\033[0m / \033[1m%s\033[0m\n' "$PASSWORD"
fi
printf '  Login is set in %s (BASIC_AUTH_USERNAME / BASIC_AUTH_PASSWORD)\n' "$ENV_FILE"
printf '  Logs:  journalctl -u releasewatcher -f\n'
