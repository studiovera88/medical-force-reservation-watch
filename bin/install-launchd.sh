#!/bin/zsh
set -euo pipefail

LABEL="com.hinata.medical-force-reservation-watch"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ENV_FILE="$PROJECT_ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$PROJECT_ROOT/.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE. Add DISCORD_WEBHOOK_URL, then run this installer again."
  exit 1
fi

if ! grep -q '^DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/' "$ENV_FILE" \
  && ! grep -q '^DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/' "$ENV_FILE"; then
  echo "Set DISCORD_WEBHOOK_URL in $ENV_FILE before installing launchd."
  exit 1
fi

mkdir -p "$PROJECT_ROOT/logs" "$PROJECT_ROOT/data"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$PROJECT_ROOT/bin/run-once.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_ROOT</string>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$PROJECT_ROOT/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT_ROOT/logs/launchd.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed $LABEL. It checks every 5 minutes."
