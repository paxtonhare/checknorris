#!/bin/bash
# Deploy to a Linux host over SSH as a user systemd service (no sudo needed) and expose the dashboard with tailscale serve.
# Usage: scripts/deploy.sh <ssh-host> [remote-dir]
set -euo pipefail
host=$1; dir=${2:-checknorris}
src=$(cd "$(dirname "$0")/.." && pwd)

ssh "$host" bash -s "$dir" <<'REMOTE'
set -euo pipefail
dir=$1
if ! "$HOME/.local/node/bin/node" --version 2>/dev/null | grep -q '^v2[4-9]'; then
  v=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v24.")))')
  arch=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
  echo "installing node $v"; mkdir -p "$HOME/.local"; rm -rf "$HOME/.local/node"
  curl -fsSL "https://nodejs.org/dist/$v/node-$v-linux-$arch.tar.xz" | tar -xJ -C "$HOME/.local" && mv "$HOME/.local/node-$v-linux-$arch" "$HOME/.local/node"
fi
mkdir -p "$HOME/$dir" "$HOME/.config/systemd/user"
REMOTE

rsync -az --delete --exclude .git --exclude checkouts --exclude 'checknorris.db*' --exclude node_modules "$src/" "$host:$dir/"
# First deploy only: seed the remote with local state so already-reviewed PRs are not reviewed again.
if [ -f "$src/checknorris.db" ] && ! ssh "$host" test -e "$dir/checknorris.db"; then scp -q "$src/checknorris.db" "$host:$dir/checknorris.db"; fi

ssh "$host" bash -s "$dir" <<'REMOTE'
set -euo pipefail
dir=$1
cat > "$HOME/.config/systemd/user/checknorris.service" <<UNIT
[Unit]
Description=Check Norris PR reviewer
After=network-online.target

[Service]
WorkingDirectory=%h/$dir
ExecStart=%h/.local/node/bin/node checknorris.ts
Restart=always
RestartSec=10
Environment=PATH=%h/.local/node/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now checknorris.service
systemctl --user restart checknorris.service
sleep 3; systemctl --user --no-pager status checknorris.service | head -5
port=$(python3 -c 'import json; print(json.load(open("'"$HOME/$dir"'/config.json")).get("port", 3940))')
tailscale serve --bg "$port" 2>&1 | tail -3 || echo "tailscale serve failed; dashboard is on localhost:$port only"
REMOTE
