# AIHOT 车载行业热点网站部署说明

## 部署状态

✅ **部署完成** - 所有服务已在服务器 172.17.13.184 上成功运行

### 服务状态
- **Web 服务**: 运行中 (端口 3000)
- **API 服务**: 运行中 (端口 3001)
- **Worker 服务**: 运行中
- **数据库**: PostgreSQL 12 已配置，57 个迁移已应用
- **信源数据**: 9 个示范信源已导入

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

**管理员密码**: `Aihot2026Deploy!`

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
- 同步代码到服务器
- 安装依赖
- 运行数据库迁移
- 重启服务

## 配置说明

### 环境变量 (/opt/aihot/.env)

关键配置项：
- `SITE_URL=http://103.99.75.133:3000` - 网站对外地址
- `DATABASE_URL=postgres://aihot:aihot@127.0.0.1:5432/aihot` - 数据库连接
- `ADMIN_PASSWORD=Aihot2026Deploy!` - 管理员密码
- `COLLECT_ENABLED=false` - 采集开关（需要配置模型后开启）
- `MODEL_CALLS_ENABLED=false` - 模型调用开关

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
ssh -p 17177 root@172.17.13.184 "tail -f /opt/aihot/logs/api.log"

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
├── .env              # 环境配置
├── start.sh          # 启动脚本
├── .data/            # 数据目录
└── logs/             # 日志目录
```

## 故障排查

### 服务无法访问
1. 检查服务是否运行：`ps aux | grep 'node apps'`
2. 检查端口监听：`netstat -tlnp | grep :3000`
3. 查看日志：`tail -50 /opt/aihot/logs/web.log`

### 数据库连接失败
1. 检查 PostgreSQL：`ps aux | grep postgres`
2. 测试连接：`psql postgres://aihot:aihot@127.0.0.1:5432/aihot`

### 需要重新初始化
```bash
# 停止服务
pkill -f "node apps"

# 重新运行部署脚本
bash scripts/deploy-direct.sh 172.17.13.184 18177
```

## 技术栈

- **运行时**: Node.js 24.21.0
- **数据库**: PostgreSQL 12
- **框架**: TypeScript + npm workspaces
- **部署方式**: 直接部署（无 Docker）

## 注意事项

1. 服务器重启后需要重新运行 `bootstrap-server.sh` 和 `deploy-direct.sh`
2. `.env` 文件包含敏感信息，不要提交到 Git
3. 生产环境部署前请修改 `ADMIN_PASSWORD` 和其他密钥
4. 当前使用 PostgreSQL 12，部分高级特性（如 LZ4 压缩）不可用

---

**部署时间**: 2026-10-08  
**部署脚本位置**: `scripts/deploy-direct.sh`, `scripts/bootstrap-server.sh`, `scripts/tunnel-web.sh`
