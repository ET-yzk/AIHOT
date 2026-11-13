# 本地 WSL 部署（systemd）

这套是 2026-11-13 起的主部署方式：**WSL 里用用户级 systemd 管 API、worker、web，PostgreSQL 用系统级 cluster service**。远端 `scripts/deploy-direct.sh` 保持原样，随时可以切回服务器。

全程不需要 PowerShell：服务由 systemd 管理，部署和备份都是 WSL 里的 bash 脚本。

## 架构

| 组件 | 位置 | 管理方式 |
|---|---|---|
| PostgreSQL 17 | WSL `/var/lib/postgresql/17/main`，端口 5433 | `systemctl`（系统级 `postgresql@17-main`） |
| API | WSL `/home/zkye/project/regwatch`，127.0.0.1:3001 | `systemctl --user regwatch-api` |
| worker | 同上 | `systemctl --user regwatch-worker`（默认不启动，见下） |
| web | 同上，127.0.0.1:3000 | `systemctl --user regwatch-web` |
| 备份 | WSL `~/regwatch-backups` + `F:\backup\09-regwatch` | `systemctl --user regwatch-backup.timer`，每天 04:10，保留 7 份 |
| 公网入口 | `http://172.17.13.62/` → 本机 3000 | 本机 `regwatch-relay`（反向 SSH）+ .62 的 `regwatch-web.socket` |

入口：**http://127.0.0.1:3000**（本机；不要用 `localhost`，Windows 会先解析成 IPv6 `::1`，而 web 只监听 IPv4）。
同事访问 **http://172.17.13.62/**，链路见下面「公网入口」。

## Node：用 nvm，不用系统 Node

- nvm default 目前是 **v24.22.3**（仓库要求 `>=24.22.1`）
- 服务不硬编码版本，统一走 `scripts/node-local.sh`：source nvm → `nvm which default` → exec
- 手工命令：

```bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use default
```

## 启停

```bash
systemctl --user status regwatch.target
systemctl --user restart regwatch.target
systemctl --user stop regwatch.target

systemctl --user restart regwatch-api
systemctl --user restart regwatch-web
journalctl --user -u regwatch-api -f
journalctl --user -u regwatch-web -f
```

worker 默认被 `ConditionPathExists=/home/zkye/project/regwatch/.worker-enabled` 跳过，避免在采集/模型关闭时补跑 10-14 之后缺失的日报，刷出大量 “no judgement” 错误。要恢复采集/成刊时：

```bash
touch /home/zkye/project/regwatch/.worker-enabled
systemctl --user start regwatch-worker
```

## 部署（Windows 改完代码之后）

代码在 Windows 的 `E:\project\AIHOT` 开发和提交，WSL 的仓库以它作为 `origin`。先 commit，再在 Windows 上跑一条：

```powershell
wsl -u zkye -e bash /home/zkye/project/regwatch/scripts/deploy-local.sh
```

或者在 WSL 里：

```bash
cd ~/project/regwatch && ./scripts/deploy-local.sh
```

它做：

1. `git pull --ff-only origin dev`
2. `npm install` + `npm run build -w @aihot/web`
3. `scripts/migrate.ts`
4. 把仓库里的 `deploy/systemd-user/*` 安装到 `~/.config/systemd/user/` 并 `daemon-reload`
5. 重启 api / worker / web，启动备份 timer

未提交的改动不会被部署。

## 备份

`regwatch-backup.timer` 每天 04:10 跑 `scripts/backup-local.sh`：

1. `pg_dump -Fc` 到 `~/regwatch-backups/aihot-YYYYmmdd-HHMM.dump`（WSL 里的暂存）
2. `pg_restore --list` 验证
3. 复制到 `F:\backup\09-regwatch\`，并用 `sha256sum` 重写 `SHA256SUMS.txt`
4. 两边各保留最新 **7 份**（7 天滚动）

F: 没挂上时（比如盘被拔掉），脚本会打印 `WARNING` 并只保留 WSL 里那份，不会让整个备份失败。
timer 带 `Persistent=true`：如果 04:10 时 WSL 没在跑，下次启动会补跑一次。

手动跑一次：

```bash
systemctl --user start regwatch-backup.service
systemctl --user --no-pager status regwatch-backup.service
ls -lh ~/regwatch-backups /mnt/f/backup/09-regwatch
```

## 开机自启

- WSL 已开 `systemd=true`，`zkye` 有 linger，`regwatch.target` 和 `regwatch-backup.timer` 已 enable。
- WSL 本身已配置成随 Windows 启动；它起来后 linger 会自动拉起 `regwatch.target`。
- 已验证 `wsl --shutdown` 后重新启动，PG 和 `regwatch.target` 会自动恢复。
- 如果之后要在**无人登录**时也运行，需要 WSL 的启动方式覆盖“未登录”场景（计划任务选“无论用户是否登录都运行”，或配置自动登录）。

## 公网入口（172.17.13.62:80）

```
同事浏览器 → 172.17.13.62:80
           → systemd-socket-proxyd（.62，root）
           → 172.17.13.62:127.0.0.1:3000（反向 SSH 隧道）
           → 本机 WSL 127.0.0.1:3000
```

- 本机：`regwatch-relay.service` 用 `~/.ssh/regwatch-relay` 连 `zkye@172.17.13.62`，
  在对面绑 `127.0.0.1:3000`，断线 10 秒重连；由 `regwatch.target` 拉起。
- .62：`regwatch-web.socket` + `regwatch-web.service` 监听 80 并转发到 `127.0.0.1:3000`。
  一次性安装（需要 root）见 `deploy/relay-host/README.md`。
- 本机 IP 变了不用改 .62 的配置；Windows 防火墙也不用为 3000 开口。
- `SITE_URL` 要写 `http://172.17.13.62:80`，否则页面里的绝对链接会指向 127.0.0.1。

排错顺序：`.62` 上 `curl http://127.0.0.1/api/health` → `.62` 上 `curl http://127.0.0.1:3000/api/health`
→ 本机 `systemctl --user status regwatch-relay`。

## 切回远程服务器

本地和远程是两套独立环境，数据不共享：

1. 停本地：`systemctl --user stop regwatch.target`
2. 部署远程（服务器恢复后）：`bash scripts/deploy-direct.sh 172.17.13.184 18177`
3. 远程的 `.env` / 数据库仍是它自己的；本地 WSL 的库不受影响
4. 切回本地：`systemctl --user start regwatch.target`

远程的数据库备份靠 `packages/backend/src/operations/backup.ts`（配 `DB_BACKUP_STORE_*` 后上传到 COS），
本地这套不依赖它。

## 目录

```
/home/zkye/project/regwatch/           代码、.env、.env.local、.data
/home/zkye/regwatch-backups/           WSL 里的备份暂存（7 份）
~/.config/systemd/user/regwatch-*      systemd user units
E:\project\AIHOT\deploy\systemd-user\  unit 源文件（随仓库保存）
F:\backup\09-regwatch\                 备份（7 天滚动）
E:\project\AIHOT\scripts\deploy-local.sh   部署
E:\project\AIHOT\scripts\backup-local.sh   备份
E:\project\AIHOT\scripts\node-local.sh     nvm 包装

## 数据缺口与恢复（2026-11-13）

2026-10-14 08:00 之后的数据随服务器重建丢失。2026-11-13 已按 [数据恢复记录](../regdocs/数据恢复-2026-11.md) 分三批重新采集 256 篇（2026-10-13 ~ 11-13），并接回正常出刊；恢复期间用到的开关、一次性翻页操作与已知噪声都记在那份文档里。清理记录见 [审查与清理](../regdocs/审查与清理-2026-11-13.md)。

```
