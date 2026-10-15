#!/bin/bash
# 直连部署（不用 Docker）的启动脚本：停掉 api/worker/web 再重新拉起三个进程。
# NODE_ENV=production 是 docs/deploy.md「不用 Docker」要求的：它打开 assertProductionSecrets
# 和管理员密码长度检查，并让 environmentName 报成 production（飞书告警不再带【development】前缀，
# DEV_AUTH_ROLE 免登录也不会生效）。少了它，三个进程都按开发环境运行。
cd "$(dirname "$0")"
set -a && source .env && set +a
export NODE_ENV=production
mkdir -p .data logs

# 按各自的 main 路径停服务：这些串不会出现在 `bash start.sh` 自己的命令行里，
# 所以不像 `pkill -f 'node apps'` 那样会杀掉执行它的 shell。
pkill -f "node apps/api/src/main.ts" 2>/dev/null
pkill -f "node apps/worker/src/main.ts" 2>/dev/null
pkill -f "node apps/web/server.ts" 2>/dev/null
sleep 1

nohup node apps/api/src/main.ts > logs/api.log 2>&1 &
echo "API started (PID: $!)"

nohup node apps/worker/src/main.ts > logs/worker.log 2>&1 &
echo "Worker started (PID: $!)"

nohup node apps/web/server.ts > logs/web.log 2>&1 &
echo "Web started (PID: $!)"

echo "All services started (NODE_ENV=production). Check logs/ for output."
