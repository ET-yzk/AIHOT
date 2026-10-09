#!/usr/bin/env bash
# Sync code changes to server and restart services
# Usage: ./scripts/sync.sh [server_ip] [ssh_port]
# Example: ./scripts/sync.sh 172.17.13.184 18177

set -euo pipefail

SERVER_IP="${1:-172.17.13.184}"
SSH_PORT="${2:-18177}"
REMOTE_USER="root"
REMOTE_DIR="/opt/aihot"
SSH_OPTS="-p $SSH_PORT -o StrictHostKeyChecking=accept-new"

echo "=== Syncing code to server ==="
echo "Server: $REMOTE_USER@$SERVER_IP:$SSH_PORT"
echo ""

# Test SSH connection
if ! ssh $SSH_OPTS "$REMOTE_USER@$SERVER_IP" "echo 'SSH OK'" >/dev/null 2>&1; then
    echo "ERROR: SSH connection failed"
    exit 1
fi

# Sync code
echo "[1/3] Syncing code..."
rsync -avz --delete \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.env' \
    --exclude='.data' \
    --exclude='*.log' \
    -e "ssh $SSH_OPTS" \
    ./ "$REMOTE_USER@$SERVER_IP:$REMOTE_DIR/"
echo "✓ Code synced"
echo ""

# Rebuild and restart
echo "[2/3] Rebuilding and restarting services..."
ssh $SSH_OPTS "$REMOTE_USER@$SERVER_IP" bash <<REMOTE_SCRIPT
cd $REMOTE_DIR

# Rebuild images
docker compose build --pull

# Restart services (preserves database)
docker compose up -d --force-recreate

# Wait for services
sleep 5

# Show status
docker compose ps
REMOTE_SCRIPT
echo ""

# Verify
echo "[3/3] Verifying..."
ssh $SSH_OPTS "$REMOTE_USER@$SERVER_IP" bash <<REMOTE_SCRIPT
cd $REMOTE_DIR
if docker compose ps | grep -q "api" && docker compose ps | grep -q "web"; then
    echo "✓ Services running"
    echo ""
    echo "Portal: http://$SERVER_IP:3000"
else
    echo "ERROR: Services failed to start"
    docker compose logs --tail=50
    exit 1
fi
REMOTE_SCRIPT

echo ""
echo "=== Sync complete ==="
