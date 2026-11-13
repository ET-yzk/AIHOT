# AIHOT 车载行业热点网站部署说明

## 部署状态

**当前主部署：本地 WSL**（2026-11-13 起，详见 [`docs/deploy-local.md`](deploy-local.md)）
- 入口：**http://127.0.0.1:3000**（不要用 `localhost`，Windows 会先解析成 IPv6 `::1`）
- API 3001、web 3000 都只监听回环；PostgreSQL 17 在 5433
- 用户级 systemd：`regwatch-api` / `regwatch-worker` / `regwatch-web`，由 `regwatch.target` 聚合
- 数据库 **79 个迁移**、26 个信源；业务数据截止 **2026-10-14 08:00**

**远程服务器 172.17.13.184:18177**：2026-11-13 已不可达（旧 Pod 重置，root 公钥随根盘丢失）。
恢复后按本文档的 `bootstrap-server.sh` + `deploy-direct.sh` 重新部署；本地和远程是两套独立环境。

三个进程都带 `NODE_ENV=production` 启动，`start.sh` 负责设置它。少了它，api 和 worker
会跳过 `assertProductionSecrets`（占位符/过短密钥、`DEV_AUTH_*` 免登录都不会拒绝启动），
`ADMIN_PASSWORD` 的长度下限也不检查，飞书告警会带上【development】前缀。

### 访问方式

本地 WSL：直接打开 **http://127.0.0.1:3000**，不需要隧道。

远程部署时，由于服务器网络配置，需要通过 SSH 隧道访问 Web 界面：

```bash
# 方法 1：使用脚本（推荐）
bash scripts/tunnel-web.sh

# 方法 2：手动建立隧道
ssh -p 18177 -L 3000:127.0.0.1:3000 root@172.17.13.184 -N

# 然后在浏览器打开：
http://127.0.0.1:3000
```

### 管理后台

本地：`http://127.0.0.1:3000/admin`；远程隧道：`http://127.0.0.1:3000/admin`。

管理员密码在 `.env` 的 `ADMIN_PASSWORD` 里（服务器是 `/opt/aihot/.env`，本地是
`/home/zkye/project/regwatch/.env`，本机 `E:\project\AIHOT\.env` 同一份），不写进这份文档。

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

**在这台机器上要从 Git Bash 跑，别从 WSL 跑。** PowerShell 里的 `bash` 解析到 WSL 的启动器
（`C:\Users\<你>\AppData\Local\Microsoft\WindowsApps\bash.exe`），而 WSL 里那个 ssh 会去读
`/home/zkye/.ssh/id_rsa`——DrvFs 上它显示成 `0755`，ssh 判定「私钥权限过开」拒绝加载，随后等认证输入，
整条 pipeline 就此停住（2026-10-18 挂了约一小时；服务器没受影响，远程那句 `rm -rf` 在认证成功之后才跑）。
用 Git Bash 的绝对路径，它的 `$HOME` 是 Windows 那份，ssh 用得上能用的 key：

```powershell
& "C:\Program Files\Git\bin\bash.exe" scripts/deploy-direct.sh 172.17.13.184 18177
```

放部署前可以先单跑一条 ssh 确认认证（`-o BatchMode=yes` 让它失败即退出，不会挂在密码提示上）：

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 -p 18177 root@172.17.13.184 'echo AUTH_OK'
```

脚本会自动：
- 同步代码到服务器（`node_modules`、`.env`、`.data`、日志、本机的 `apps/web/build` 和
  `server-backups/` 都不发：网页在服务器上构建，备份只留本机）
- **同步之前先拦一道**：本机仓库根上只要有「git 没跟踪、tar 又会带上」的顶层条目（被 gitignore 的也算——
  `tar` 不认识 `.gitignore`，2026-10-12 那次就是这么把 `server-backups/` 里 12 MB 整库 dump 传上去的），脚本会
  点名它们并直接退出，不等东西出门。**`.gitignore` 挡不住 `tar`，被忽略的目录照样出门**（就是 2026-10-12 那次的机制，
  所以「那你去 gitignore」是一条会走不通的建议）；处理办法是挪出仓库根、或在这句 tar 里为它补一条 `--exclude`，
  确实要带上则写 `DEPLOY_ALLOW_UNTRACKED=1 bash scripts/deploy-direct.sh 172.17.13.184 18177`。拦下来的那一步 ssh 一次都没被叫到
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

### 日志留多久
`start.sh` 把三个进程的输出直写进 `/opt/aihot/logs/*.log`，文件描述符一直握在进程手里，所以滚动只能用 `copytruncate`（进程既不重启也不收信号）。仓库带了 `deploy/logrotate-aihot`，期限 90 天（`rotate 90` + `maxage 90`，按日期命名并压缩）。**隐私说明第 3 节向读者承诺的就是这一份**：没装它之前，日志实际是「到下一次 `start.sh` 为止」（`>` 重定向每次启动清空重写），90 天那条话还不成立。

这是本站自己的决定，不是上游给的：上游那份框架对日志什么都不管——`docker-compose.yml` 没有一条 `logging` 限制（Docker 默认 json-file，不封顶），`docs/deploy.md` 只教怎么 `docker compose logs -f` 看，隐私模板 §3 原文是「请在这里写明你实际使用的服务和保存期限」。

两点关于这个 90 天的实话：

- 它是**上限**，不是下限。`start.sh` 用 `>` 重定向，每次部署都把当前文件清零，所以真能攒到 90 天的情况是「连续 90 天没部署」——本站不像那样，实际多半更短。
- 要让历史真的跨部署累积，得把 `start.sh:18-24` 那三个 `>` 换成 `>>`。**先装 logrotate 再改这个**，反过来做的话，一个没人轮转的追加文件迟早把磁盘写满——那是一次全站故障，不是排障便利。

装一次：
```bash
install -m 644 /opt/aihot/deploy/logrotate-aihot /etc/logrotate.d/aihot
logrotate -d /etc/logrotate.d/aihot   # 只演练不写，确认它认这份配置
```
Debian/Ubuntu 上 logrotate 由系统每天的定时任务驱动；`-d` 是 dry-run，不会真的滚动。

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

### 被锁在数据库门外怎么办

三道认证要分清：应用连的是**角色 `aihot`**（回环 TCP，scram，密码只写在 `.env` 的 `DATABASE_URL` 里）；
跑测试用的是**角色 `aihot_ci`**（`CREATEDB`，凭据在服务器上的 `/root/ci-lane.env`，600，故意不进仓库）；
`postgres` 超级用户只走**本机 socket 的 peer 认证**，root 的 shell 拿它连会报 `Peer authentication failed`，
要 `su - postgres -s /bin/bash -c "psql …"`。

真的登不上时按这个顺序，不要先改密码：

1. 先用 peer 这条路进去确认库还在：`su - postgres -s /bin/bash -c "psql -Atc 'select current_database(), now()'"`
   ——peer 不要密码，所以**这条永远可用**，不存在数据彻底拿不到的情况。
2. 先转储再动手：`su - postgres -s /bin/bash -c "pg_dump aihot -Fc -f /tmp/rescue.dump"`（放到 `/tmp`，
   postgres 用户写不了 `/opt/aihot`）。
3. 重置应用角色的密码成 `.env` 里 `DATABASE_URL` 带的那个值（`ALTER ROLE aihot PASSWORD …`），
   改密码命令别把值写进带引号的命令行历史里，可以用 `psql` 交互执行。
4. 三处要一致，否则下次部署又会漂回去：`/opt/aihot/.env`、本机 `/.env`、以及 `deploy-direct.sh` 第 3 步——
   **每次部署都会拿 `.env` 里的 URL 重设角色密码并重新落 pg_hba**，所以只要两边的 `.env` 一致就不会漂。
   比一致性只比摘要，别打印值：`grep -m1 '^DATABASE_URL=' .env | sha256sum | cut -c1-12` 两边各跑一次，
   数要相同。
5. 改完 `bash /opt/aihot/start.sh`（三个进程都带 `NODE_ENV=production`），再看 `logs/` 和
   `psql -h 127.0.0.1 -U aihot -d aihot -Atc 'select 1'`。

### 跑测试的那套库（车道）

`npm test` 的 `DATABASE_URL` 指的**不是**站点的库，是一个**模板库**：`tests/databases.ts` 的 globalSetup
先看它在不在（不在就建、再打一遍迁移），然后**每个测试文件**从它 `CREATE DATABASE … TEMPLATE` 拷一份自己用，
收尾删掉拷贝——并行 6 个文件互不共享行、也不重复跑 61 个迁移。服务器上这份是 `/root/ci-lane.env` 里的
`aihot_lane2_ci`。

两条要紧的：

- **单文件跑必须带上那两个参数**，照 `package.json` 的写法：
  `node --test-global-setup=tests/databases.ts --import ./tests/databases.ts --test tests/某个.test.ts`。
  裸跑 `node --test tests/x.test.ts` 不走拷贝逻辑，**会直接把行写进模板库**；模板一旦带行，之后每个文件
  都从它拷贝就都带着这些行，于是一片 `reports_kind_key` 之类的唯一键冲突，看着像代码坏了。
  认法：红的名字横跨互不相干的文件、报的都是唯一键冲突，且模板库体积明显大于 ~10 MB。
- **不要 `DROP` 模板库**。要干净的，换个以 `_ci` 结尾的名字让 globalSetup 自己建（今天就是这么从
  `aihot_rw_ci` 换到 `aihot_lane2_ci` 的），旧的留着别动。

## 本地 WSL 部署（2026-11-13 起的主部署）

从 2026-11-13 起，线上跑在本地 WSL，用用户级 systemd 管 API、worker、web（和 hermes 同一套方式），
PostgreSQL 用系统级 `postgresql@17-main`。本机入口是 **http://127.0.0.1:3000**（不要用 `localhost`，
Windows 会先解析成 IPv6 `::1`，而 web 只监听 IPv4），同事通过 **http://172.17.13.62/** 访问
（.62 的 80 → 本机反向隧道 → 3000）。数据每天备份到 WSL 的 `~/regwatch-backups`
并镜像到 `F:\backup\09-regwatch`，两边各保留 7 份。

完整的目录、启停、worker 开关、备份和开机自启说明见 [`docs/deploy-local.md`](deploy-local.md)。

这份文档剩下的部分讲**远程服务器部署**，仍然有效：服务器恢复后按上面的
`bootstrap-server.sh` + `deploy-direct.sh` 部署即可。本地和远程是两套独立环境、数据不共享：

- 切到远程：先 `systemctl --user stop regwatch.target`，再跑 `bash scripts/deploy-direct.sh 172.17.13.184 18177`
- 切回本地：远程停掉 `start.sh`，本地 `systemctl --user start regwatch.target`
- 不要同时让 Windows 的 `scripts/start-local.ps1` 和 WSL 的 `regwatch.target` 抢 3000/3001

## 技术栈

- **运行时**: Node.js 24.21.0（直接跑 TypeScript，后端没有构建步骤；只有网页要构建）
- **数据库**: PostgreSQL 17（装在本机，127.0.0.1:5432；本地 WSL 用 5433）
- **框架**: TypeScript + npm workspaces
- **部署方式**: 直接部署（无 Docker）

## 注意事项

1. 服务器重启后需要重新运行 `bootstrap-server.sh` 和 `deploy-direct.sh`
2. `.env` 文件包含敏感信息，不要提交到 Git，也不要抄进文档
3. 生产环境部署前请修改 `ADMIN_PASSWORD` 和其他密钥
4. `deploy-direct.sh` 会同步本机 `.env` 覆盖服务器那份，动手前确认两边键集一致：
   `grep -oE '^[A-Z][A-Z0-9_]*=' .env | sort` 两边各跑一次再 diff
5. 本地 worker 默认被 `ConditionPathExists=.worker-enabled` 挡住，恢复采集前先
   `touch /home/zkye/project/regwatch/.worker-enabled`
6. 本地入口是 `127.0.0.1:3000`，不要用 `localhost`（IPv6 `::1` 会超时）

---

**最近一次核对**:
- 2026-11-13：本地 WSL systemd 部署（`wsl --shutdown` 重建后 `pg/target/api/web` 全部自动 active，健康检查 200；`deploy-local.sh` 跑通；备份 dump 恢复校验 79 条迁移 / 358 文章 / 6 报告 / 26 信源）
- 2026-10-12：远程 `bash scripts/deploy-direct.sh` 全量跑通，`node scripts/smoke.ts` 30 项全绿，三个进程 `NODE_ENV=production`

**部署脚本位置**: 本地 `scripts/deploy-local.sh`、`deploy/systemd-user/`；远程 `scripts/deploy-direct.sh`, `scripts/bootstrap-server.sh`, `scripts/tunnel-web.sh`, 根目录 `start.sh`
