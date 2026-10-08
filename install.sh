#!/usr/bin/env bash
# Installs the collector and web server as systemd services (e.g. on a Raspberry Pi).
#
#   ./install.sh             install or update the services and start them
#   ./install.sh uninstall   stop and remove the services
#
# Run it from the project folder as your normal user. It calls sudo when it needs to.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"
SERVICES=(flight-collector flight-web)
UNIT_DIR=/etc/systemd/system

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

die() { echo "Error: $*" >&2; exit 1; }

if [ "${1:-}" = "uninstall" ]; then
  for s in "${SERVICES[@]}"; do
    $SUDO systemctl disable --now "$s" 2>/dev/null || true
    $SUDO rm -f "$UNIT_DIR/$s.service"
  done
  $SUDO systemctl daemon-reload
  echo "Services removed. Collected data in $APP_DIR/data was left untouched."
  exit 0
fi

command -v systemctl >/dev/null || die "systemd not found."

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "Node.js not found. Install Node 20+ first, e.g.:
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR found at $NODE_BIN, but 20 or newer is required."

if [ ! -f "$APP_DIR/.env" ]; then
  if [ -f "$APP_DIR/.env.example" ]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    echo "Created .env from .env.example. Set MAPBOX_TOKEN in it, then run: sudo systemctl restart flight-web"
  else
    die "No .env found in $APP_DIR."
  fi
fi

mkdir -p "$APP_DIR/data"

# write_unit <name> <description> <script> <restart delay>
write_unit() {
  $SUDO tee "$UNIT_DIR/$1.service" >/dev/null <<EOF
[Unit]
Description=$2
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $3
Restart=always
RestartSec=$4

[Install]
WantedBy=multi-user.target
EOF
}

write_unit flight-collector "Flight heatmap collector" src/collector.js 10
write_unit flight-web "Flight heatmap web server" src/server.js 5

$SUDO systemctl daemon-reload
$SUDO systemctl enable flight-collector flight-web
# restart (not start) so re-running the script picks up code or config changes
$SUDO systemctl restart flight-collector flight-web

PORT="$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2 | tr -d '[:space:]' || true)"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

echo
echo "Installed and started as user $RUN_USER, using $NODE_BIN."
echo "Map:    http://${IP:-<pi-ip>}:${PORT:-3000}"
echo "Status: systemctl status flight-collector flight-web"
echo "Logs:   journalctl -u flight-collector -f"
