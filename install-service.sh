#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/ad-ui.service"

if [ ! -f "$SERVICE_FILE" ]; then
  echo "Error: ad-ui.service not found in $SCRIPT_DIR"
  exit 1
fi

echo "Installing AD UI service..."
echo "Make sure you've edited ad-ui.service with your username and paths first!"
echo ""

sudo cp "$SERVICE_FILE" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable ad-ui
sudo systemctl start ad-ui
sudo systemctl status ad-ui
