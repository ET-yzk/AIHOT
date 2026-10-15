#!/bin/bash
# SSH tunnel to access AIHOT web interface
# Usage: bash scripts/tunnel-web.sh
# Then open http://localhost:3000 in your browser

SERVER="172.17.13.184"
PORT="18177"
USER="root"

echo "Creating SSH tunnel to $SERVER:$PORT..."
echo "Web interface will be available at: http://localhost:3000"
echo "Press Ctrl+C to close the tunnel"
echo ""

ssh -p $PORT -L 3000:127.0.0.1:3000 $USER@$SERVER -N
