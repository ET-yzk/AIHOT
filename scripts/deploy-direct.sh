#!/bin/bash
# One-click deploy for direct (non-Docker) deployment.
# Usage: bash scripts/deploy-direct.sh [server_ip] [ssh_port]
#
# Prerequisites:
#   - Local .env file in project root (will be copied to server)
#   - Node.js 24+ on server
#   - PostgreSQL 17 running (run bootstrap-server.sh after server reset)
#
# This script:
#   1. Syncs code to /opt/aihot on the server
#   2. Copies local .env to server
#   3. Installs npm dependencies
#   4. Runs database migrations
#   5. Seeds demo sources
#   6. Starts all services (API, Worker, Web)

set -e

SERVER_IP="${1:-172.17.13.184}"
SSH_PORT="${2:-18177}"
REMOTE_DIR="/opt/aihot"
SSH_OPTS="-p $SSH_PORT -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
LOCAL_ENV="$(cd "$(dirname "$0")/.." && pwd)/.env"

if [ ! -f "$LOCAL_ENV" ]; then
  echo "ERROR: .env not found at $LOCAL_ENV"
  echo "       Copy .env.example to .env and fill in your config first."
  exit 1
fi

echo "==> Syncing code to $SERVER_IP:$REMOTE_DIR ..."
tar czf - --exclude='.git' --exclude='node_modules' --exclude='.env' --exclude='.data' --exclude='*.log' . \
  | ssh $SSH_OPTS "root@$SERVER_IP" "mkdir -p $REMOTE_DIR && cd $REMOTE_DIR && rm -rf apps packages industry site modules database scripts && tar xzf -"

echo "==> Fixing JSON encoding (curly quotes) ..."
ssh $SSH_OPTS "root@$SERVER_IP" "sed -i 's/\xe2\x80\x9c/\"/g; s/\xe2\x80\x9d/\"/g' $REMOTE_DIR/industry/sources.json 2>/dev/null || true"

echo "==> Copying .env to server (converting line endings) ..."
sed 's/\r$//' "$LOCAL_ENV" | ssh $SSH_OPTS "root@$SERVER_IP" "cat > $REMOTE_DIR/.env"

echo "==> Installing npm dependencies ..."
ssh $SSH_OPTS "root@$SERVER_IP" "cd $REMOTE_DIR && npm install 2>&1 | tail -5"

echo "==> Running database migrations ..."
ssh $SSH_OPTS "root@$SERVER_IP" "cd $REMOTE_DIR && set -a && source .env && set +a && node scripts/migrate.ts 2>&1 | tail -5"

echo "==> Seeding demo sources ..."
ssh $SSH_OPTS "root@$SERVER_IP" "cd $REMOTE_DIR && set -a && source .env && set +a && node scripts/seed.ts 2>&1"

echo "==> Starting services ..."
ssh $SSH_OPTS "root@$SERVER_IP" "pkill -f 'node apps' 2>/dev/null; sleep 1; cd $REMOTE_DIR && bash start.sh"

echo ""
echo "==> Deployment complete!"
echo "    Access via SSH tunnel:"
echo "    ssh -p $SSH_PORT -L 3000:127.0.0.1:3000 root@$SERVER_IP -N"
echo "    then open http://localhost:3000"
