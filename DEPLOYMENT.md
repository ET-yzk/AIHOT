# AIHOT 车载行业热点网站部署说明

## 部署状态

✅ **部署完成** - 所有服务已在服务器 172.17.13.184 上成功运行

### 服务状态
- **Web 服务**: 运行中 (端口 3000)
- **API 服务**: 运行中 (端口 3001)
- **Worker 服务**: 运行中
- **数据库**: PostgreSQL 17（本机），61 个迁移已应用
- **信源数据**: 21 个信源已导入

三个进程都带 `NODE_ENV=production` 启动，`start.sh` 负责设置它。少了它，api 和 worker
会跳过 `assertProductionSecrets`（占位符/过短密钥、`DEV_AUTH_*` 免登录都不会拒绝启动），
`ADMIN_PASSWORD` 的长度下限也不检查，飞书告警会带上【development】前缀。

### 访问方式

由于服务器网络配置，需要通过 SSH 隧道访问 Web 界面：

```bash
# 方法 1：使用脚本（推荐）
bash scripts/tunnel-web.sh

# 方法 2：手动建立隧道
ssh -p 18177 -L 3000:127.0.0.1:3000 root@172.17.13.184 -N

# 然后在浏览器打开：
http://localhost:3000
```

### 管理后台

访问 `http://localhost:3000/admin` 登录管理后台

管理员密码在服务器的 `/opt/aihot/.env` 里（`ADMIN_PASSWORD`，本机 `/.env` 同一份），不写进这份文档。

## 一键部署脚本

### 首次部署（服务器重启后）

```bash
# 1. 初始化服务器（只需运行一次）
bash scripts/bootstrap-server.sh

# 2. 部署应用
bash scripts/deploy-direct.sh 172.17.13.184 18177
```

### 日常更新部署

```bash
# 修改代码后，直接运行部署脚本
bash scripts/deploy-direct.sh 172.17.13.184 18177
```

脚本会自动：
- 同步代码到服务器（`node_modules`、`.env`、`.data`、日志、本机的 `apps/web/build` 和
  `server-backups/` 都不发：网页在服务器上构建，备份只留本机）
- 安装依赖
- **构建网页**（`npm run build -w @aihot/web`）——只发源码不构建等于白部署，`apps/web` 的改动
  在线上看不到就是这个原因
- 运行数据库迁移，导入信源
- 用 `start.sh` 重启三个进程
- 逐个确认进程在，并检查它们确实带 `NODE_ENV=production`；有一项不对就报错退出，不会打印「部署完成」

## 配置说明

### 环境变量 (/opt/aihot/.env)

关键配置项（值以服务器上的 `/opt/aihot/.env` 为准，本机 `/.env` 与它逐键一致，`deploy-direct.sh` 会用本机这份覆盖服务器那份）：
- `SITE_URL=http://103.99.75.133:3000` - 网站对外地址
- `DATABASE_URL=postgres://aihot:<密码>@127.0.0.1:5432/aihot` - 数据库连接（密码写在 URL 里，见「数据库连接失败」）
- `ADMIN_PASSWORD` - 管理员密码，生产环境要求至少 12 位
- `COLLECT_ENABLED=false` - 采集开关（需要配置模型后开启）
- `MODEL_CALLS_ENABLED=false` - 模型调用开关
- `LLM_TIMEOUT_MS=300000` - 单次模型请求超时，默认 120000；模型偶发慢响应时放大它

### 启用内容采集和模型处理

当前采集和模型调用已关闭。要启用：

1. 编辑 `/opt/aihot/.env`，添加模型配置：
```bash
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=your-api-key
LLM_MODEL=deepseek-flash
```

2. 修改开关：
```bash
COLLECT_ENABLED=true
MODEL_CALLS_ENABLED=true
```

3. 重启服务：
```bash
bash /opt/aihot/start.sh
```

## 服务管理

### 查看服务状态
```bash
ssh -p 18177 root@172.17.13.184 "ps aux | grep 'node apps'"
```

### 查看日志
```bash
# Web 日志
ssh -p 18177 root@172.17.13.184 "tail -f /opt/aihot/logs/web.log"

# API 日志
ssh -p 18177 root@172.17.13.184 "tail -f /opt/aihot/logs/api.log"

# Worker 日志
ssh -p 18177 root@172.17.13.184 "tail -f /opt/aihot/logs/worker.log"
```

### 重启服务
```bash
ssh -p 18177 root@172.17.13.184 "bash /opt/aihot/start.sh"
```

## 文件结构

```
/opt/aihot/
├── apps/              # 应用代码
├── packages/          # 共享包
├── industry/          # 行业配置
├── site/              # 本站文案、模型、品牌、条款
├── modules/           # 只有本站需要的功能模块
├── .env              # 环境配置（600，不进 Git）
├── start.sh          # 启动脚本：仓库根目录那一份，随部署同步过来
├── apps/web/build/   # 网页构建产物，在服务器上生成，不从本机上传
├── .data/            # 数据目录
└── logs/             # 日志目录
```

`start.sh` 以前只存在于服务器上，仓库里没有——机器重置后就没了，而 `deploy-direct.sh` 最后一步正是调它。现在它进了版本库，由同步带上；改动请直接改仓库里那份再部署。

## 故障排查

### 服务无法访问
1. 检查服务是否运行：`ssh -p 18177 root@172.17.13.184 "ps -eo pid,args | grep '[n]ode apps'"`
   （隧道要重开：`ssh -p 18177 -L 3000:127.0.0.1:3000 root@172.17.13.184 -N`）
2. 检查端口监听：`ss -ltnp | grep :3000`
3. 查看日志：`tail -50 /opt/aihot/logs/web.log`
4. 改了 `apps/web` 但线上没变化：先看构建产物新不新，
   `stat -c %y /opt/aihot/apps/web/build/server/index.js`；不新就是没走 `deploy-direct.sh`，
   补一次 `npm run build -w @aihot/web` 再 `bash /opt/aihot/start.sh`

### 数据库连接失败
1. 检查 PostgreSQL：`ps aux | grep postgres`
2. 本机 socket 走 `peer`、回环 TCP 走 `scram-sha-256`，没有 trust。root 直接 `psql -U postgres`
   会报 `Peer authentication failed`；用 `.env` 里 `DATABASE_URL` 带的密码连回环：
   `PGPASSWORD=$(sed -nE 's#^DATABASE_URL=postgres(ql)?://[^:]+:([^@]+)@.*#\2#p' /opt/aihot/.env) psql -h 127.0.0.1 -U aihot -d aihot`
   （别把密码打印出来；`su - postgres` 那条走的是另一个角色，会撞权限）

### 需要重新初始化
```bash
# 停服务并在服务器上重跑部署（start.sh 会自己按各 main 路径停旧进程）
bash scripts/deploy-direct.sh 172.17.13.184 18177
```
不要在 `ssh "…"` 的命令行里写 `pkill -f 'node apps'`：远端那个 shell 的命令行本身含这串，
pkill 会把它自己所在的会话杀掉，后面的重启根本不会执行（`deploy-direct.sh` 原来就是这么坏的）。

## 技术栈

- **运行时**: Node.js 24.21.0（直接跑 TypeScript，后端没有构建步骤；只有网页要构建）
- **数据库**: PostgreSQL 17（装在本机，127.0.0.1:5432）
- **框架**: TypeScript + npm workspaces
- **部署方式**: 直接部署（无 Docker）

## 注意事项

1. 服务器重启后需要重新运行 `bootstrap-server.sh` 和 `deploy-direct.sh`
2. `.env` 文件包含敏感信息，不要提交到 Git，也不要抄进文档
3. 生产环境部署前请修改 `ADMIN_PASSWORD` 和其他密钥
4. `deploy-direct.sh` 会同步本机 `.env` 覆盖服务器那份，动手前确认两边键集一致：
   `grep -oE '^[A-Z][A-Z0-9_]*=' .env | sort` 两边各跑一次再 diff

---

**最近一次核对**: 2026-10-12（`bash scripts/deploy-direct.sh` 全量跑通，`node scripts/smoke.ts` 23 项全绿，三个进程 `NODE_ENV=production`）
**部署脚本位置**: `scripts/deploy-direct.sh`, `scripts/bootstrap-server.sh`, `scripts/tunnel-web.sh`, 根目录 `start.sh`
