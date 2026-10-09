#!/usr/bin/env bash
# Check deployment status and logs
# Usage: ./scripts/status.sh [server_ip] [ssh_port]

set -euo pipefail

SERVER_IP="${1:-172.17.13.184}"
SSH_PORT="${2:-18177}"
REMOTE_USER="root"
REMOTE_DIR="/opt/aihot"
SSH_OPTS="-p $SSH_PORT -o StrictHostKeyChecking=accept-new"

echo "=== AIHOT Deployment Status ==="
echo "Server: $REMOTE_USER@$SERVER_IP:$SSH_PORT"
echo ""

# Check SSH
if ! ssh $SSH_OPTS "$REMOTE_USER@$SERVER_IP" "echo 'SSH OK'" >/dev/null 2>&1; then
    echo "ERROR: SSH connection failed"
    exit 1
fi

# Get status
ssh $SSH_OPTS "$REMOTE_USER@$SERVER_IP" bash <<REMOTE_SCRIPT
cd $REMOTE_DIR

echo "=== Service Status ==="
docker compose ps
echo ""

echo "=== Resource Usage ==="
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"
echo ""

echo "=== Recent Logs (last 20 lines) ==="
docker compose logs --tail=20 --no-color
echo ""

echo "=== Disk Usage ==="
du -sh /opt/aihot 2>/dev/null || echo "N/A"
docker system df 2>/dev/null || echo "N/A"
REMOTE_SCRIPT
