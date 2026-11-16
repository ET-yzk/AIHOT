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
#   3. Gives the database role the password .env names and requires it in pg_hba.conf
#   4. Installs npm dependencies
#   5. Builds the web app
#   6. Runs database migrations
#   7. Seeds demo sources
#   8. Starts all services (API, Worker, Web)

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

echo "==> Syncing code to $REMOTE_DIR on $SERVER_IP ..."
# Build output and the local backup dir stay out: the server builds its own bundle below, and
# server-backups/ holds a database dump and a copy of .env.
# Refuse first, then pack. `tar` walks `.`, so it does not consult .gitignore: anything left loose in
# the worktree travels. 2026-10-12 shipped a whole database dump that way (server-backups/<date>/
# backup-*.dump, 12 MB) before its exclude existed, and re-measuring on 2026-10-13 found two more
# top-level scratch dirs (vibe-sources/, vibe_images/, 336 KB). An untracked file that arrives also
# becomes a file the server tree has and the repo does not — which is what an overwrite-only sync can
# never explain away afterwards. This checks at run time rather than growing an exclude list, because a
# list only covers the names someone remembered to add. DEPLOY_ALLOW_UNTRACKED=1 ships them on purpose.
if [ "${DEPLOY_ALLOW_UNTRACKED:-0}" != "1" ]; then
  LEAK=""
  for name in $(git -C "$(dirname "$0")/.." ls-files --others --directory | sed 's#/$##' | grep -v / | sort -u); do
    # Skip exactly what the tar below excludes. A name listed here but not there is a leak; a name
    # excluded here but not there is a false refusal, so keep the two lists in step.
    case "$name" in
      .env | .env.* | .data | .learnings | .git | server-backups | node_modules | *.log | 我的开发笔记本.md) continue ;;
    esac
    LEAK="$LEAK $name"
  done
  if [ -n "$LEAK" ]; then
    echo "ERROR: not tracked by git, would be packed by the tar below:$LEAK"
    echo "       .gitignore does not stop tar, so being ignored is not enough. Move them out of the repo"
    echo "       root, add an --exclude for each below, or set DEPLOY_ALLOW_UNTRACKED=1 to ship them."
    exit 1
  fi
  echo "    nothing untracked at the top level"
fi
# 我的开发笔记本.md is the user's own note, tracked on purpose so it lives with the repo. The server
# never reads it, so it stays out of the package. Being tracked is why the guard above cannot stop
# it: that branch only looks at untracked names, so the exclude has to exist here and in that case list.
tar czf - --exclude='.git' --exclude='node_modules' --exclude='.env' --exclude='.data' --exclude='.learnings' --exclude='*.log' \
  --exclude='apps/web/build' --exclude='apps/web/.react-router' --exclude='server-backups' \
  --exclude='我的开发笔记本.md' . \
  | ssh $SSH_OPTS "root@$SERVER_IP" "mkdir -p $REMOTE_DIR && cd $REMOTE_DIR && rm -rf apps packages industry site modules database scripts && tar xzf -"

echo "==> Fixing JSON encoding (curly quotes) ..."
ssh $SSH_OPTS "root@$SERVER_IP" "sed -i 's/\xe2\x80\x9c/\"/g; s/\xe2\x80\x9d/\"/g' $REMOTE_DIR/industry/sources.json 2>/dev/null || true"

echo "==> Copying .env to server (converting line endings) ..."
sed 's/\r$//' "$LOCAL_ENV" | ssh $SSH_OPTS "root@$SERVER_IP" "cat > $REMOTE_DIR/.env"

echo "==> Enforcing the database password that .env carries ..."
ssh $SSH_OPTS "root@$SERVER_IP" "cd $REMOTE_DIR && bash -s" <<'REMOTE'
set -euo pipefail
url=$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)
if ! printf '%s' "$url" | grep -qE '^postgres(ql)?://[^:@/]+:[^@]+@'; then
  echo "  DATABASE_URL carries no password, leaving pg_hba as the server has it"
  exit 0
fi
db_user=$(printf '%s' "$url" | sed -nE 's#^postgres(ql)?://([^:@/]+).*#\2#p')
db_pass=$(printf '%s' "$url" | sed -nE 's#^postgres(ql)?://[^:@/]+:([^@]*)@.*#\2#p')
case "$db_user" in
  [a-z_]*) ;;
  *) echo "  unexpected database user name in DATABASE_URL: $db_user"; exit 1 ;;
esac
# The password goes to psql on stdin, never in an argument list.
printf "ALTER ROLE %s PASSWORD '%s';\n" "$db_user" "$(printf '%s' "$db_pass" | sed "s/'/''/g")" \
  | su - postgres -s /bin/bash -c "psql -q -v ON_ERROR_STOP=1"
echo "  role $db_user now authenticates with the password in .env"

hba=/etc/postgresql/17/main/pg_hba.conf
if grep -qE '^[[:space:]]*(local|host)([[:space:]]+(all|replication)){2}[[:space:]]+([0-9./:[:space:]]+)?[[:space:]]*trust[[:space:]]*$' "$hba"; then
  backup=/root/pg_hba.conf.bak-$(date +%Y%m%d-%H%M%S)
  cp -a "$hba" "$backup"
  sed -i -E \
    -e 's#^(local[[:space:]]+all[[:space:]]+all[[:space:]]+)trust[[:space:]]*$#\1peer#' \
    -e 's#^(local[[:space:]]+replication[[:space:]]+all[[:space:]]+)trust[[:space:]]*$#\1peer#' \
    -e 's#^(host[[:space:]]+all[[:space:]]+all[[:space:]]+(127\.0\.0\.1/32|::1/128)[[:space:]]+)trust[[:space:]]*$#\1scram-sha-256#' \
    -e 's#^(host[[:space:]]+replication[[:space:]]+all[[:space:]]+(127\.0\.0\.1/32|::1/128)[[:space:]]+)trust[[:space:]]*$#\1scram-sha-256#' \
    "$hba"
  if ! su - postgres -s /bin/bash -c "psql -Atc 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL'" >/dev/null 2>&1; then
    cp -a "$backup" "$hba"; echo "  pg_hba.conf stopped parsing, restored $backup"; exit 1
  fi
  left=$(su - postgres -s /bin/bash -c "psql -Atc \"SELECT count(*) FROM pg_hba_file_rules WHERE auth_method = 'trust'\"")
  if [ "$left" != "0" ]; then
    cp -a "$backup" "$hba"; echo "  $left trust rules survived the edit, restored $backup"; exit 1
  fi
  su - postgres -s /bin/bash -c "psql -Atc 'SELECT pg_reload_conf()'" >/dev/null
  echo "  pg_hba.conf: local socket uses peer, loopback TCP uses scram-sha-256 (backup: $backup)"
else
  echo "  pg_hba.conf has no loopback trust rules to replace"
fi
REMOTE

echo "==> Installing npm dependencies ..."
ssh $SSH_OPTS "root@$SERVER_IP" "cd $REMOTE_DIR && npm install 2>&1 | tail -5"

echo "==> Building the web app ..."
ssh $SSH_OPTS "root@$SERVER_IP" "cd $REMOTE_DIR && npm run build -w @aihot/web 2>&1 | tail -8"

echo "==> Running database migrations ..."
ssh $SSH_OPTS "root@$SERVER_IP" "cd $REMOTE_DIR && set -a && source .env && set +a && node scripts/migrate.ts 2>&1 | tail -5"

echo "==> Seeding demo sources ..."
ssh $SSH_OPTS "root@$SERVER_IP" "cd $REMOTE_DIR && set -a && source .env && set +a && node scripts/seed.ts 2>&1"

echo "==> Starting services ..."
# start.sh is tracked in the repo and arrives with the tar above. It exports NODE_ENV=production,
# which is what turns on assertProductionSecrets and the admin-password floor (docs/deploy.md,
# "不用 Docker"); without it all three processes run as development. It stops each service by its
# own main path — an inline `pkill -f 'node apps'` here would match the remote shell running it
# and kill the session before anything restarted.
ssh $SSH_OPTS "root@$SERVER_IP" "cd $REMOTE_DIR && bash start.sh < /dev/null > /tmp/start.out 2>&1"

echo "==> Verifying services ..."
ssh $SSH_OPTS "root@$SERVER_IP" bash -s <<'REMOTE'
set -uo pipefail
sleep 3
bad=0
for name in "apps/api/src/main.ts" "apps/worker/src/main.ts" "apps/web/server.ts"; do
  pid=$(ps -eo pid,args | grep -F "node $name" | grep -v grep | awk '{print $1}' | head -1)
  if [ -z "$pid" ]; then
    echo "  MISSING: $name"; bad=1; continue
  fi
  got=$(tr '\0' '\n' < "/proc/$pid/environ" | grep '^NODE_ENV=' | head -1)
  echo "  pid=$pid $name ${got:-NODE_ENV=(unset)}"
  [ "$got" = "NODE_ENV=production" ] || bad=1
done
if [ "$bad" != "0" ]; then
  echo "  not all three are up in production mode; read logs/ and /tmp/start.out"
  exit 1
fi
REMOTE

echo ""
echo "==> Deployment complete!"
echo "    Access via SSH tunnel:"
echo "    ssh -p $SSH_PORT -L 3000:127.0.0.1:3000 root@$SERVER_IP -N"
echo "    then open http://localhost:3000"
