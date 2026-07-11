#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/x9-ui.service"

if [ ! -f "$SERVICE_FILE" ]; then
  echo "Error: x9-ui.service not found in $SCRIPT_DIR"
  exit 1
fi

echo "Installing X9 UI service..."
echo "Make sure you've edited x9-ui.service with your username and paths first!"
echo ""

sudo cp "$SERVICE_FILE" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable x9-ui
sudo systemctl start x9-ui
sudo systemctl status x9-ui
