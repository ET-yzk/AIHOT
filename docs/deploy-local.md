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
| 备份 | WSL `~/regwatch-backups` + Windows `E:\project\AIHOT\server-backups\live` | `systemctl --user regwatch-backup.timer`，每天 04:10 |

入口：**http://127.0.0.1:3000**（不要用 `localhost`；Windows 会先解析成 IPv6 `::1`，而 web 只监听 IPv4）。

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

1. `pg_dump -Fc` 到 `~/regwatch-backups/aihot-YYYYmmdd-HHMM.dump`
2. `pg_restore --list` 验证
3. 两边各保留最新 40 份
4. 复制一份到 `/mnt/e/project/AIHOT/server-backups/live/`，并用 `sha256sum` 重写 `SHA256SUMS.txt`

Windows 那个盘没挂上时（E: 不可用），脚本会打印 `WARNING` 并只保留 WSL 里那份，不会让整个备份失败。所以 WSL 副本是主，Windows 副本是异地拷贝。

手动跑一次：

```bash
systemctl --user start regwatch-backup.service
systemctl --user --no-pager status regwatch-backup.service
ls -lh ~/regwatch-backups /mnt/e/project/AIHOT/server-backups/live
```

## 开机自启

- WSL 已开 `systemd=true`，`zkye` 有 linger，`regwatch.target` 和 `regwatch-backup.timer` 已 enable。
- Windows 登录时用启动文件夹里的 `regwatch-wsl.vbs` 静默拉起 WSL（启动后 linger 会自动起服务）：

```vbs
Set sh = CreateObject("WScript.Shell")
sh.Run "wsl.exe -d Ubuntu -u zkye -e /bin/true", 0, False
```

路径：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\regwatch-wsl.vbs`

- 已验证 `wsl --shutdown` 后重新启动，PG 和 `regwatch.target` 会自动恢复。
- 如果机器要在**无人登录**时也运行，需要把同样的命令做成“无论用户是否登录都运行”的计划任务，或配置自动登录；启动文件夹只覆盖“登录后”。

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
/home/zkye/regwatch-backups/           WSL 备份（主）
~/.config/systemd/user/regwatch-*      systemd user units
E:\project\AIHOT\deploy\systemd-user\  unit 源文件（随仓库保存）
E:\project\AIHOT\server-backups\live\  Windows 副本（异地）
E:\project\AIHOT\scripts\deploy-local.sh   部署
E:\project\AIHOT\scripts\backup-local.sh   备份
E:\project\AIHOT\scripts\node-local.sh     nvm 包装
```
