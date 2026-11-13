#!/bin/bash
# Deploys the committed repo state to the local WSL systemd stack.
# Run inside WSL from the repo root:  ./scripts/deploy-local.sh
# From Windows:  wsl -d Ubuntu -u zkye -e bash -lc 'cd ~/project/regwatch && ./scripts/deploy-local.sh'
# Remote deployment is unchanged: use scripts/deploy-direct.sh for the server.
set -euo pipefail
APP=/home/zkye/project/regwatch
cd "$APP"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm use default >/dev/null

git pull --ff-only origin dev
npm install --no-audit --no-fund
npm run build -w @aihot/web
node --env-file=.env --env-file=.env.local scripts/migrate.ts

# The units and the nvm wrapper live in the repo; keep the installed copies in sync.
mkdir -p "$HOME/.config/systemd/user"
install -m 644 deploy/systemd-user/regwatch-api.service \
  deploy/systemd-user/regwatch-web.service \
  deploy/systemd-user/regwatch-worker.service \
  deploy/systemd-user/regwatch.target \
  deploy/systemd-user/regwatch-backup.service \
  deploy/systemd-user/regwatch-backup.timer \
  "$HOME/.config/systemd/user/"
systemctl --user daemon-reload

systemctl --user restart regwatch-api.service regwatch-web.service
# The worker has ConditionPathExists=.worker-enabled, so this is a no-op until collection resumes.
systemctl --user restart regwatch-worker.service
systemctl --user start regwatch-backup.timer

systemctl --user --no-pager --full status regwatch.target | head -20
