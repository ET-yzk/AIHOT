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

`node --test apps/web/tests/*.test.ts` 在这台机器上原本 11 个里失败 9 个，同一个原因，已就地修掉（见下节），现在 11 个全绿。

---

## 开发机可运行性修正 · web 服务的入口路径

| 项 | 内容 |
|---|---|
| 文件 | `apps/web/server.ts` |
| 改动 | `await import(path.resolve(...))` 改为 `await import(pathToFileURL(path.resolve(...)).href)` |
| 原问题 | ESM loader 把 `C:\...\build\server\index.js` 里的盘符当成协议（`Received protocol 'c:'`）直接拒绝。Linux 上以 `/` 开头，被当作合法 file 路径，所以上游 CI 察觉不到 |
| 影响面 | 这台机器上 `node apps/web/server.ts` 一启动就崩，`apps/web/tests/cache.test.ts` 的 9 个用例连带全红（它们 spawn 这个文件）。改的是同一份代码在两个平台上的加载方式，缓存策略、路由、代理逻辑一行未动 |

---

## 阶段一 · 1.1 删除可选模块

删的是两个只对 AI 行业有意义的模块：模型榜（`/leaderboard`）与 Codex 重置监控（`/codex-reset`）。删除优于关闭——关掉的模块在 rebase 时仍会产生冲突，且它们的抓取任务、提示词和测试会继续静默失败。

| 项 | 内容 |
|---|---|
| 整块删除 | `packages/backend/src/leaderboard/`、`packages/backend/src/monitor/`、`packages/contracts/src/{leaderboard,monitor}.ts`、`apps/web/app/features/{leaderboard,monitor}/`、`apps/web/app/routes/leaderboard*.tsx`、`apps/web/app/routes/codex-reset.tsx`、`apps/web/app/routes/admin/monitor.tsx`、`apps/api/src/routes/leaderboard.ts`、`assets/leaderboard-sources/`、`assets/model-providers/`、`database/seeds/lb-*.json`、`docs/leaderboard.md`、`scripts/{lb-round,lb-fetch-check,import-leaderboard-prices}.ts`、`tests/{leaderboard-worker,monitor}.test.ts` |
| 一并删掉的文件 | `packages/backend/src/{admin/monitor,publication/monitor,leaderboard/*}.ts`（共 101 个文件删除） |
| `industry/features.ts` | 两个开关 `leaderboard`、`codexResetMonitor` 本身删掉了，不是设为 false；读它们的地方一起删 |
| 数据库 | **不动**。迁移只做向后兼容的增量，这些表留着不影响新行业，删表是不可逆操作 |
| 文档 | `docs/customize.md` 第 6 节改为「已删除」并保留删除清单，`docs/architecture.md` 的模块表去掉那一行（原来指向已删除的 `docs/leaderboard.md`） |

为删掉它们而改动的上游文件（rebase 时逐个核对）：`apps/api/src/{app.ts,routes/{admin,og,site,static,v1}.ts}`、`apps/web/app/{routes.ts,components/shell/nav.ts,routes/admin/{layout,runs}.tsx,routes/{agent,more}.tsx}`、`apps/worker/src/{main,schedules}.ts`、`packages/backend/src/{admin/runs,editorial/models,notify/deliver,operations/alerts,publication/{llms,sitemap}}.ts`、`packages/contracts/src/{http-policy,taxonomy}.ts`、`packages/backend/package.json`（去掉两个只有榜单用的依赖）、`scripts/{seed,smoke}.ts`、`.env.example`、`NOTICE`、`README.md`、`assets/README.md`。

---

## 阶段一 · 1.2 测试去污染

`tests/` 里 13 个文件原本把示例行业的分类 key、标签、公司名、模型名和阈值写死在断言里，换了 `industry/` 包就会红一片。现在这些值从规格里读：`CATEGORY_KEYS`、`ITEM_TYPES`、`CATEGORY_TAGS`、`TOPIC_TAGS`、`ENTITIES`、`TAG_SYNONYMS`、`IDENTITY_LEXICON`、`SELECTION.thresholds`，以及提示词渲染出来的原文（用来认「这一步是谁」而不是靠一句中文标题）。

| 项 | 内容 |
|---|---|
| 文件 | `tests/{analyze,analyze-shutdown,default-model,events,listings,materials,media-performance,publication,receipts,report-lead,signals,sources,x-shards,url}.test.ts` |
| 只改测试 | 平台代码一处没动；测试用到的常量上游都已导出 |
| 顺带发现的冲突 | `tests/sources.test.ts` 有一条断言把 P1 修掉的旧行为当成正确行为（分片 X 源不认 URL 前缀），已与 P1 同一个分支改掉 |
| 新行业加的检查 | `tests/industry-pack.test.ts`：`industry/sources.json` 的每个配置项必须是该 kind 实现的（`unsupportedConfig` 为空），owner 必须是 `ENTITIES` 里的、tier 必须在 `SELECTION.thresholds` 里有阈值，标签近义词与兜底标签必须指向规格里存在的标签 |

---

## 阶段一 · 1.3 / 1.4 行业包

改的全部在 `industry/`（站名与文案 `site.ts`、分类与标签 `taxonomy.ts`、主题 `topics.json`、信源 `sources.json`、提示词 `prompts/*.md`、门槛 `selection.ts`、模块开关 `features.ts`、品牌 `brand/`、条款模板 `pages/`、更新日志 `changelog.json`），按上游约定不算分叉，rebase 时整目录以本地为准。

三处例外，记录在此：

| 文件 | 改动 | 原因 |
|---|---|---|
| `packages/backend/src/publication/items.ts` | `categoryCondition(category, v1)` 不再把示例行业的分类写死在代码里，改为读 `industry/taxonomy.ts` 新导出的 `PUBLIC_CATEGORY_FOLDS` | 原来那段代码硬编码了「观点并入快讯」这类示例行业规则，属于把 `industry/` 的规则泄漏到平台层，换个行业就是错的 |
| `packages/contracts/src/taxonomy.ts` | 对外分类 key 列表改为从规格派生 | 同上，`apps/api/src/routes/v1.ts` 里那份兜底分类常量也随之删掉 |
| `industry/sources.json` | 换成车载信源，仍然只用上游已有的 kind（`json_list` / `web_list` / `rss`），零新增 | 信源清单归使用者定；没核实的接口不能当成已核实，未验证的一律 `enabled=false` |

`industry/sources.json` 的验证状态（`tests/industry-pack.test.ts` 只保证配置项合法，不碰网络）：

| 信源 | 状态 |
|---|---|
| `json-sac-gb`（国家标准全文公开系统） | 开发机上取到过真实 JSON，字段路径已按返回体核对（`rows`、`C_C_NAME`、`C_STD_CODE`、`ISSUE_DATE` 为 `YYYY-MM-DD`、`STATE=现行` 用来过滤被代替的标准） |
| `json-miit-zcwj`（工信部政策文件搜索） | 开发机上取到过真实 JSON，结果数组路径与 `deploytime`（epoch 毫秒）已核对；按 `deploytime` 排序，并配了 `ingestNoiseFilter` 挡住通信/无线电类公告 |
| `rss-euroncap-news` | 有效 RSS 2.0，取到过条目 |
| `json-cncap-pingjia` | **未验证**：那是 POST 接口，开发机上 GET 探不到；`enabled=false`，等后台「试抓」通过 |
| `web-catarc-news`、`web-catarc-wp29` | **未验证**：列表选择器是按常见页面结构写的猜测；`enabled=false`，等「试抓」通过 |

需要真实浏览器的 EUR-Lex / IVISTA 不属于声明式配置，走 `POST /api/ingest/items`（上游已有该路由与 `external` kind）。

---

## 阶段一 · 1.6 运营基线

### 新增文件（自有代码集中在这些位置，不算分叉）

| 文件 | 内容 |
|---|---|
| `scripts/doctor.ts` | 部署期自检：迁移是否齐、信源配置对该 kind 是否合法、`industry/sources.json` 与库内是否漂移、正在失败或降级的源、模型服务有没有预算行且没被设到网关限额之上、知识层可达性、`COLLECT_ENABLED`/`MODEL_CALLS_ENABLED` 开关状态。只读，不写库，不抓取。跑法 `node scripts/doctor.ts`，有问题退出码 1 |
| `database/migrations/0040_model_budget_rate.sql` | 模型服务的每分钟预算设到 36（网关 40 RPM，与站外对话代理共用配额，DES §9.4）。后台「设置」里仍可继续调，这里只定新部署的初值 |

### 对上游文件的修改

| 文件 | 改动 | 原因 |
|---|---|---|
| `packages/backend/src/operations/alerts.ts` | 新增 `source.failing` 告警（`today` 级）：启用的源 health 为 failing 且 24 小时内没成功过就报，最多列 5 个并带最近失败原因 | 上游只有「网站停止收录」这种整体判断：一个法规发布源连续失败时其它信源仍在更新，网站看起来一切正常，只在周报表里露一次面。信源失败是阶段一要求必须告警的三项之一（实施方案 §1.6），另外两项（预算熔断、报道卡住）上游已有，未改动 |

已核对上游本来就有、因此未改的告警：`content.collect` 停止收录、`content.process` 新内容卡住、`report.daily` 日报没生成、服务方拒绝服务与 24 小时额度用完、备份失败与过期、队列积压、结果未知的付费请求与推送。

---

## 阶段一 · 1.5 周报与月报的内容 feed（CT-5）

RegPilot 的渲染器要的是内容（导语、编辑分好的区块、按阅读顺序排好的引用条目），不是画好的卡片。上游只有日报有 v1 端点，周报/月报没有，所以补了这一组：

| 文件 | 改动 |
|---|---|
| `packages/backend/src/publication/reports.ts` | 追加 `PERIODIC_KINDS`、`v1Reports(kind, limit)`、`v1Report(kind, key \| "latest")`，都建在已有的 `loadReport` 上；被撤下的引用标 `withdrawn` 而不是悄悄消失 |
| `apps/api/src/routes/v1.ts` | 新增 6 条路由（`/api/v1/reports/{weekly,monthly}`、`/latest`、`/{key}`）；期号形状不对是 400，存在但没出过是 404，不认的参数是 400 |
| `packages/contracts/src/http-policy.ts` | 新增 `reports` / `latestReport` / `reportByKey` 三种缓存策略（指定期号是既成内容，`max-age=3600`） |
| `packages/backend/src/publication/links.ts` | 新增 `reportUrl(kind, key?)` |
| `packages/backend/src/publication/llms.ts` | llms.txt 里补上周报/月报 feed 的发现入口 |
| `apps/web/app/routes/agent.tsx` | 接入指南的端点表补两行 |
| `reference/public-v1.openapi.json` | 6 条路径 + 6 个 schema，改动与既有条目逐条深度比对过（每个原条目内容不变，只是插入位置移动）。后来又删掉了已不存在的 `/api/v1/codex-resets` 两条路径和五个只有它用的 schema |
| `tests/reports-feed.test.ts` | 新增。最后一个用例把「服务在跑的路由」与「契约里写的路径」双向对齐：多一条没文档的路由、或少一条不再服务的路径，都会红 |

---

## 阶段一 · 1.7 飞书多维表格投影（CT-4）

迁移期的汇报视图。方向只有一条：Postgres → 飞书表，平台里没有任何东西读这张表，所以不存在冲突解决。

| 项 | 内容 |
|---|---|
| 新增 | `packages/backend/src/projection/bitable.ts`、`database/migrations/0041_feishu_projection.sql`（`projection_rows`：`job`+`entity_key` 记 `row_token` 与 `row_hash`）、`tests/feishu-projection.test.ts` |
| 数据来源 | 公开读取层的 `v1Items(mode:"selected", window:"7d", by:"timeline")`，与门户首页同一份数据，因此表格不会多出门户上没有的行 |
| 幂等 | 逐行按「本任务拥有的那几个格子」算 hash，hash 相同不发送；一个安静的 15 分钟一次 API 调用都不发 |
| `upsert_preserve` | 平台算不出来的格子（例如没有发布日期）从请求里整个去掉，不写空值覆盖别人填的东西；门户撤下的行会被标 `已撤下` 并清掉本任务拥有的摘要与链接 |
| 开关 | `FEISHU_BITABLE_ENABLED` 默认 false；关掉时只算计划并上报，不发任何 HTTP。状态先答开关再答凭据：关了开关的人看到的是 `disabled`（带计划），不是 `unconfigured`。测试用本地 stub，不出网 |
| 对上游文件的修改 | `packages/backend/src/config.ts` 加 `feishuBitableEnabled`；`notify/feishu.ts` 把 `API` 与 `tenantToken` 导出给投影复用，并让 `FEISHU_API_BASE` 可以指向本地 stub（测试用的缝）；`apps/worker/src/schedules.ts` 加 `projection.bitable`（`*/15 * * * *`）；`.env.example` 加三个键 |
| 未做 | 法规字段（`regulation_tracking`）的投影属于 2.9，阶段一不碰；卡片渲染仍由 RegPilot 出（CT-5 之后半段） |

---

## 阶段一 · 站点跑起来以后发现的写死行业词

把站点真的跑起来看了一遍，才发现有一批读者可见文案把示例行业词写死在代码里，不读 `industry/site.ts` 的 `subject`：`/weekly` 的浏览器标题是「AI 周报」，报头字（nameplate SVG）画的也是「AI周报」。1.2 只去了测试里的写死值，页面里的没去。

| 文件 | 改动 |
|---|---|
| `apps/web/app/routes/report-latest.tsx` | 页面标题与空状态改成 `withSubject(KIND_LABEL[kind])` |
| `apps/web/app/features/report/ReportPaper.tsx` | 报头的 sr-only 一行、往期导航的兜底标题、`往期 X` 的 Kicker 三处同样走 `withSubject` |
| `apps/web/app/features/report/format.ts` | `headline()` 的「N 件 AI 大事」走 `withSubject("大事")` |
| `apps/web/app/routes/hot.tsx` | meta 描述与页面上的「AI 圈讨论最多的」改成「车载行业里被说得最多的」 |
| `apps/web/app/routes/admin/feedback.tsx` | 副标题里写死的签名「AI HOT」改成 `${SITE.name}` |
| `industry/prompts/{report-daily-lead,report-period}.md` | 「入选的 AI 动态」→「入选的车载行业动态」（`industry/`，不算分叉） |
| `industry/prompts/summarize-long-post.md` | 编辑身份改成车载行业；「优先保留的数字」的例子换成标准号与版本号、法规文号、发布与实施日期、条款编号、限值、车型名称、测评星级与得分、销量与渗透率 |
| `industry/brand/nameplates/*.svg` + `index.json` | 用 `node scripts/nameplates.ts <noto-sans-sc 包目录>` 重新生成（字体不是依赖：`npm pack @fontsource/noto-sans-sc@5.3.0` 解开即可）。viewBox 变宽是「车载」两个方块字比 "AI" 占位多 |

**保留的「AI」**：`Score.tsx` 的「AI 评分」、`item.tsx` 的「AI 导读」「正文 · AI 翻译」、`story.tsx` 的「AI 综述 / AI 根据报道生成」。这些说的是这一段内容出自模型，是机制披露，不是行业词，换行业之后仍然成立。

---

## 阶段一 · CI 与 README 里跟着包走的数字

| 文件 | 改动 |
|---|---|
| `.github/workflows/check.yml` | docker 作业的「库里应该有 18 个信源」改成从 `industry/sources.json` 现读现比（`grep -qx "$EXPECTED"`）。18 是上游示例包的信源数，车载包是 6 个，写死的数字第一次推 CI 就会红 |
| `README.md` | 「仓库带了 18 个公开的海外 AI 资讯源做示范」按本仓库实际内容改写，不再报上游的示范名单 |

这类数字只能有一个来源：包本身。验收记录见 `regdocs/阶段一验收记录.md`。
