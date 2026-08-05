#!/bin/zsh
set -euo pipefail

LABEL="com.hinata.medical-force-reservation-watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "Uninstalled $LABEL."
