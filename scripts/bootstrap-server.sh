#!/bin/bash
# Server bootstrap: install PG17 and prepare the database.
# Run once after server reset.
#
# Usage (from local):
#   ssh -p 18177 root@172.17.13.184 "bash /opt/aihot/scripts/bootstrap-server.sh"

set -e

echo "==> Installing PostgreSQL 17 ..."

apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release

# Add Aliyun PGDG mirror
echo 'deb https://mirrors.aliyun.com/postgresql/repos/apt focal-pgdg main' > /etc/apt/sources.list.d/pgdg.list
curl -fsSL https://mirrors.aliyun.com/postgresql/repos/apt/keys/ACCC4CF8.asc | apt-key add - 2>/dev/null
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-17 postgresql-contrib-17

echo "==> Creating PG17 cluster ..."

# Drop any auto-created cluster and recreate with UTF-8
pg_dropcluster 17 main --stop 2>/dev/null || true
pg_createcluster 17 main --start -- --locale=C.UTF-8 --encoding=UTF8 --auth=trust

echo "==> Setting up database ..."

su - postgres -s /bin/bash -c "psql -c \"CREATE USER aihot WITH PASSWORD 'aihot';\"" 2>/dev/null || echo "  user already exists"
su - postgres -s /bin/bash -c "psql -c \"CREATE DATABASE aihot OWNER aihot ENCODING UTF8;\"" 2>/dev/null || echo "  database already exists"
su - postgres -s /bin/bash -c "psql -d aihot -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;'"

echo "==> Bootstrap complete. Now run: bash scripts/deploy-direct.sh"
