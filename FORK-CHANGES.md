# FORK-CHANGES — 对上游核心代码的本地修改清单

本仓库是 AIHOT 的派生，目标是车载行业动态与法规知识平台（设计文档见 `regdocs/`）。

上游不会动的定制面是 `industry/`，改它不算分叉。**这个文件只记录对上游代码的修改**：
每次 rebase 上游之后逐项核对下表，确认改动仍然成立、仍然必要。

新增的自有代码集中在 `packages/backend/src/regulation/` 与 `media/documents.ts`，不散改进上游文件。

---

## 阶段一 · 开工前置（P1 / P2 / P3）

### P1 — 收录围栏 `allowUrlPrefixes` / `denyUrlPrefixes` 覆盖分片抓取

| 项 | 内容 |
|---|---|
| 文件 | `packages/backend/src/sources/collect.ts`、`sources/config-keys.ts`、`docs/sources.md` |
| 改动 | `collectXShard()` 里给候选项补上 `allowed(c.url, m)` 过滤；`x_search` 的配置项白名单补 `allowUrlPrefixes`/`denyUrlPrefixes`；文档写清生效域 |
| 原问题 | `collectSource()` 已经对所有经由它的 kind 应用了这两个前缀规则，但 X 账号按分片走 `collectXShard()`，那条路径只做了 `rewriteUrl` 和 `noiseFiltered`，前缀围栏对分片源无效 |
| 影响面 | 只有设置了这两个配置项的 `x_search` 源行为变化（多一层过滤），其余 kind 不变 |

### P2 — 内网出访窄白名单 `INTERNAL_EGRESS_ALLOW`

| 项 | 内容 |
|---|---|
| 文件 | `packages/backend/src/config.ts`、`lib/url.ts`、`lib/http-fetch.ts`、`.env.example` |
| 改动 | `config.internalEgressAllow`（host 或 host:port 列表）；新增 `internalEgressPermitted(url, allowlist)`；`guardedFetch` 在 `route:"direct"` 且命中名单时跳过私网拒绝，并走一个不做 guarded lookup 的独立 dispatcher |
| 原问题 | 生产启动拒绝 `ALLOW_PRIVATE_NETWORK_FETCH`（`config.ts:assertProductionSecrets`），而知识层（WeKnora）部署在局域网地址上，阶段三的原文推送必须能连到它 |
| 安全边界 | 精确匹配 host，或 host:port；不是前缀匹配，没有通配。只有显式 `route:"direct"` 的调用认这份名单，抓取流量（`route:"egress"`）仍然完全受 SSRF 防护。名单为空时行为与改动前一致 |

### P3 — 模型客户端并发闸门

| 项 | 内容 |
|---|---|
| 文件 | `packages/backend/src/providers/llm.ts`、`config.ts`、`.env.example` |
| 改动 | `chatJson()` 的请求执行体外面加一个容量 `config.llmMaxConcurrency`（默认 5）的信号量 `enterModel()/leaveModel()` |
| 原问题 | 上游网关同时限制每分钟速率和并发请求数；`receipts` 预算表达的是速率，约束不了并发，worker 的分析并发叠上分块与翻译会同时打出超过 5 个请求 |
| 影响面 | 只影响等待时间，不改变任何调用语义；`MODEL_CALLS_ENABLED=false` 时不产生请求，闸门不参与 |

---

## 本地测试基线（Windows 开发机）

跑法：`docker run -d --name aihot-pg -p 5433:5432 -e POSTGRES_USER=aihot -e POSTGRES_PASSWORD=aihot -e POSTGRES_DB=aihot_test postgres:17-alpine`，
再 `node scripts/migrate.ts` + `node scripts/seed.ts --topics-only`，数据库名必须以 `_test` 或 `_ci` 结尾。

在未改动的上游代码上，`npm test` 有 8 个测试在这台 Windows 机器上必定失败，与本地修改无关：

| 测试 | 数量 | 原因 |
|---|---|---|
| `tests/analyze-shutdown.test.ts`、`tests/translate-shutdown.test.ts` 里的 SIGTERM 用例 | 5 | 子进程收不到 POSIX 信号，测试等到超时。Windows 上 `child.kill('SIGTERM')` 是终止进程，不是优雅停机 |
| `tests/translate.test.ts` 的三个用例 | 3 | 打桩 provider 的并发行为在这台机器上不稳定，其中一个必然等到超时 |

**判断有没有引入回归，比对失败测试的名字，不要只看红绿。** 这 8 个必须在 Linux（CI 的 `.github/workflows/check.yml`）上跑绿才算过。

---

## 阶段一 · 1.1 删除可选模块

见下方「已删除的上游模块」。删除优于关闭：关掉的模块在 rebase 时仍会产生冲突。
