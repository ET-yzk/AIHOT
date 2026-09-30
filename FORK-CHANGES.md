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
| 2026-09-30 复查这一项的 DoD | 「无残留调度/路由」重新走了一遍：`apps/api/src/routes/` 只剩 11 个文件、没有 `leaderboard.ts`；`apps/worker/src/schedules.ts` 里 grep `leaderboard|monitor|codex` 零命中；`apps/`、`packages/`、`scripts/` 全量 grep 只剩**一句注释**——`packages/backend/src/lib/http-fetch.ts:10` 把「榜单数据」当作出网流量的例子之一。它既不是调度也不是路由，为了注释去动核心管线文件要在原则 1 上开口子，所以留着；rebase 时看见这行不必以为模块没删干净 |
| 复查时修掉的文档 | `industry/README.md` 的表还在列 `features.ts`，`docs/customize.md` 第 6 节的写法读起来像那个文件还在。两处都改成「行业包里没有『模块开关』这一项，文件本身不存在」。**`AGENTS.md` 第 7 行也还列着「模块开关（`features.ts`）」**——那是给 Agent 看的说明，改不改由使用者点头 |

为删掉它们而改动的上游文件（rebase 时逐个核对）：`apps/api/src/{app.ts,routes/{admin,og,site,static,v1}.ts}`、`apps/web/app/{routes.ts,components/shell/nav.ts,routes/admin/{layout,runs}.tsx,routes/{agent,more}.tsx}`、`apps/worker/src/{main,schedules}.ts`、`packages/backend/src/{admin/runs,editorial/models,notify/deliver,operations/alerts,publication/{llms,sitemap}}.ts`、`packages/contracts/src/{http-policy,taxonomy}.ts`、`packages/backend/package.json`（去掉两个只有榜单用的依赖）、`scripts/{seed,smoke}.ts`、`.env.example`、`NOTICE`、`README.md`、`assets/README.md`。

---

## 阶段一 · 1.2 测试去污染

`tests/` 里 13 个文件原本把示例行业的分类 key、标签、公司名、模型名和阈值写死在断言里，换了 `industry/` 包就会红一片。现在这些值从规格里读：`CATEGORY_KEYS`、`ITEM_TYPES`、`CATEGORY_TAGS`、`TOPIC_TAGS`、`ENTITIES`、`TAG_SYNONYMS`、`IDENTITY_LEXICON`、`SELECTION.thresholds`，以及提示词渲染出来的原文（用来认「这一步是谁」而不是靠一句中文标题）。

| 项 | 内容 |
|---|---|
| 文件 | `tests/{analyze,analyze-shutdown,default-model,events,listings,materials,media-performance,publication,receipts,report-lead,signals,sources,x-shards,url}.test.ts` |
| 只改测试 | 平台代码一处没动；测试用到的常量上游都已导出 |
| 顺带发现的冲突 | `tests/sources.test.ts` 有一条断言把 P1 修掉的旧行为当成正确行为（分片 X 源不认 URL 前缀），已与 P1 同一个分支改掉 |
| 新行业加的检查 | `tests/industry-pack.test.ts`：`industry/sources.json` 的每个配置项必须是该 kind 实现的（`unsupportedConfig` 为空），owner 必须是 `ENTITIES` 里的、tier 必须在 `SELECTION.thresholds` 里有阈值，标签近义词与兜底标签必须指向规格里存在的标签；另加一组「四方一致」的契约检查——从 `database/migrations/` 读出的 CHECK 枚举（`sources.kind`、`reports.kind`）必须与包内用到的 kind（且只能是 `rss`/`web_list`/`json_list`）和 `reference/public-v1.openapi.json` 公布的报端点一致，`SELECTION.regulationCategories` 必须是 `CATEGORIES` 里的分类。读的是迁移文件而不是活库，这个文件仍然不连库、不出网 |

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

### 与 DEV-PROMPT「采集适配器裁决」表的差异（信源清单归使用者定，先记在这里）

| 站点 | 裁决表 | 现在的包 | 差在哪 |
|---|---|---|---|
| MIIT | `rss × 2`（RSSHub 镜像 + 原生 RSS） | `json-miit-zcwj`，`json_list` 打它的政策文件搜索接口 | 这台机器上没有跑 RSSHub，原生 RSS 又没核实过，搜索接口是取到过真实返回的那一个。2026-09-30 试抓：端点活着、15 条都有日期，但**它不认 `sortFields`**——`deploytime`/`publishtime`/`cdate` 三种写法返回同一批 2004—2013 的老文件，所以这条只进得了存量，拿不到新政策文件。换回 `rss` 或改走栏目接口之前，别把它当活源看 |
| C-NCAP | `json_list × 5` | 只有 `json-cncap-pingjia` 一条；2026-09-30 试抓通过（20 条、20 条都有日期、最新一条 2026-09-03）后 `enabled=true` | 另外四个是 POST 接口，开发机上探不到，没有核实依据，不能凭猜测写成四条 |
| UNECE / WP.29 | `rss` + `web_list` | 只有 `web-catarc-wp29`，2026-09-30 试抓**判为声明式不可用**：`itemSelector` 只命中导航项（首页、工作成果），`parseMode: markdown` 零条——列表是脚本渲染的 | UNECE 自己的 RSS 端点没核实过。这一条按裁决表应当归到外部推送器那一栏（`POST /api/ingest/items`），不是漏配一个选择器 |
| EUR-Lex / IVISTA / CATARC | 外部推送器 | 推送器进程未做；门那头的 `POST /api/ingest/items` 本轮补了测试（`tests/ingest-push.test.ts`：占位 token 拒绝、未知信源建成 `external`+`isolated`、同 URL 不产生第二篇、旧日期算 backfill、未来日期不信只留 claim、超 50 条整批 413、每分钟十次的自带限流） | 阶段一只交付推送端点本身，推送器进程不在阶段一范围内 |

### 派生仓库的这一项（1.1 验收）

`upstream = https://github.com/KKKKhazix/AIHOT.git` 已配好并 fetch（只读，没推送；`origin` 仍是使用者的 fork）。按 1.1 做了 **rebase 实测**：本机 `main`（`589f79e`）正好是与上游的分叉点，上游领先 12 个 commit；把 `dev` rebase 到 `upstream/main` 并不无冲突——两处：`apps/web/app/features/leaderboard/Evidence.tsx`（上游改了、我们按 G8 删了，继续删即可）和 `packages/backend/src/operations/alerts.ts`（上游继续改我们删过「重置监控」的那一带，要手工合）。细节与值得捞的上游修复列在 `regdocs/阶段一验收记录.md` 第 10 节；真做 rebase 归使用者点头，因为它动主线。

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
| 测试的两处坑 | ① 测试文件共用一个库，别的文件留下的入选条目也会进投影，所以每轮先 `settle()` 把当时的门户投影一遍再清零发送记录，计数才只代表本文件刚发布的东西。② `selected_ledger.visible_at` 是第二道闸门：一条还在未来的台账行会把可见前沿停在那里，排在它后面的条目（连本文件自己刚发的）也读不到，所以每轮删掉指向已删文章的台账行，并把还在未来的放行 |

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
| `.github/workflows/check.yml`（安全阀那一步） | docker 作业里那句 `sed` 之后加了两条 `grep -qx` 断言，要求 `.env` 里 `COLLECT_ENABLED=false` 与 `MODEL_CALLS_ENABLED=false` 确实成立。原因：这两个阀**默认是开的**（`COLLECT_ENABLED` 读作「不等于 false 就是开」，`MODEL_CALLS_ENABLED` 在 `config.ts:67` 缺省 true），而 compose 的 `env_file: .env` 会把 `.env` 灌进容器。哪一天上游给 `.env.example` 那两行加了注释或改了写法，`sed` 就静默不匹配，CI 里的 worker 会真去抓国标委/工信部/Euro NCAP/C-NCAP 并真调模型。本地验证过两个方向：照现在的模板两条断言都过；把模板里那行改成注释，断言就红。FEISHU_* 与 INDEXNOW_* 不加断言，因为它们缺省就是关，且投影在缺凭据时先答 `unconfigured` 再发请求 |

这类数字只能有一个来源：包本身。验收记录见 `regdocs/阶段一验收记录.md`。

---

## 阶段一 · 对外契约字段改名 `links.aihot → links.portal`

1.1 要求所有核心修改都记在这里、rebase 时逐项核对。这一条是**破坏性契约修改**：使用者 2026-09-29 定、2026-09-30 点头执行（原话「全新实现的项目，没有历史兼容需求」）。理由不是好看——这个键名是本框架旧产品的名字，而站点已经不叫它了。

| 项 | 内容 |
|---|---|
| 改的 12 个文件 | `packages/contracts/src/site.ts`（类型）、`packages/backend/src/publication/{items,v1,stories,reports,publish,llms}.ts`、`packages/backend/src/projection/bitable.ts`（飞书表那一列本来就叫「门户链接」，值跟着改）、`apps/api/src/routes/mcp.ts`（给 Agent 的文本行）、`reference/public-v1.openapi.json`（24 处，含各 `required` 列表）、`tests/{publication,reports-feed}.test.ts` |
| 没改的 | `publication/feeds.ts` 里那个叫 `aihot` 的**局部变量**（值是本站链接，不进任何对外契约）、`docker-compose.yml` 与 `package.json` 的服务名/包名、`_aihot` 配置键与 `@aihot/*` 导入——改它们只增加 rebase 冲突面，对外一个字都不变 |
| 存量数据的坑 | `publications` 表里的 `links` 是**发布那一刻写进去的 JSON**：改名之前发布的行仍然带 `aihot` 键，读出来 `links.portal` 是 undefined。`publishArticle` 重发一次就好，本地清库最快。**任何跑过旧版本的库都要做这一次重发**，不是可跳过的步骤 |
| 怎么验的 | 全新库全量套件（147 个，只剩那 8 个 Windows 必红）+ 把 API 真跑起来看：`/openapi-v1.json` 里 `"aihot"` 0 处、`"portal"` 24 处；`/api/v1/items` 与 `/api/v1/hot-topics` 的 `links` 是 `{portal, original[, story]}`；`/llms.txt` 讲 `links.portal` |
| rebase 时怎么合 | 上游对 `publication/*.ts` 里 links 相关的改动要**手动把键名写成 portal**，别照抄回来；`reference/public-v1.openapi.json` 冲突时以本仓库的键名为准（它是模板，带 `{{siteName}}`/`{{siteUrl}}`） |
| 与 DEV-PROMPT 核心原则的关系 | 这是对原则 1（核心管线只追加、不改既有数据流）的**一次明示例外**：改的是既有对外字段名，依据是使用者 2026-09-30 的点名指令，不是顺手改。原则 3（`publications` 一行都不能改）**没有被碰**：`git diff main..dev -- packages/backend/src/publication/publish.ts` 只有 4 行——`V1ItemPayload.links` 的类型、`v1Payload()` 里的局部变量与两处 `links`/`attribution`，`publish.ts:246` 起的 29 元组 `INSERT` 一字未动。以后核这条：那条 diff 只允许出现 links 相关的行 |

### 顺手补上的门面试测试

`tests/ingest-push.test.ts`（新增文件，六个用例）覆盖 `POST /api/ingest/items`——1.4 的「要真实浏览器的信源做成外部推送器」和阶段三的原文推送都从这门进。平台侧 `packages/backend/src/ingest/items.ts` 与 `apps/api/src/routes/ingest.ts` **一行没动**，只是第一次有人测它。

---

## 阶段一 · 读者拿得走的两处上游名字

改完 `links.portal` 以后把「不署旧产品的名」这条重新走查了一遍：对 `scripts/smoke.ts` 走的那 35 个对外出口逐个抓下来数 `aihot` 出现几次。结果是 HTML 里两处（`localStorage` 键名）、其余出口零处；再往页面之外找，读者**保存到本地的文件名**里还有两处。

| 文件 | 改动 |
|---|---|
| `apps/web/app/lib/markdown.ts` | 判断「这个链接是不是本站的」用的是写死的旧域名正则（两处 `https://aihot.news`）。现在读 `siteUrl()`（`SITE_URL`，没设置时回落到包里的 `SITE.defaultUrl`）。不改会有两种坏法：本站的绝对链接被当外站加 `target="_blank"`；谁的条款文案里一旦提到那个旧域名，会被剪成站内路径、链到本站一个不存在的页面。**当前 `industry/pages/` 里还没有绝对链接，所以这一步在屏幕上不改变任何东西**——它是拆雷，不是救火 |
| `apps/web/tests/markdown-links.test.ts` | 新增四个用例：站内绝对链接→相对且不开新窗口、只写域名本身也算站内、外站与那个旧域名→原样保留并 `target="_blank" rel="noopener noreferrer"`、本来就写成路径的不受影响。第 2 轮之前它是红的（旧代码把 `https://aihot.news/daily` 变成 `/daily`） |
| `apps/web/app/features/item/PosterSheet.tsx`、`apps/web/app/routes/starred.tsx` | 分享海报「保存图片」与收藏页「导出本地数据」的文件名是 `aihot-<id>.png`、`aihot-local-data-<日期>.json`——文件名是站名唯一能离开页面、进到读者电脑上的地方。改成 `${SITE.name}-…`，名字跟着包走 |

留在原地的 `aihot` 是**工程标识符**，不是署名：`@aihot/*` 工作区包名与导入、CSS `@keyframes aihot-*`、`localStorage` 键（`aihot-theme` 等五个）、会话缓存前缀 `aihot:list:` / `aihot:groups:`、`x-aihot-ssr` 请求头、原始数据里的 `_aihot` 键、`vite.config.ts` 的插件名、`publication/feeds.ts` 的局部变量。判据是「不用 devtools 就看不到」；改它们只会加 rebase 冲突面，对外出口读得到的一句话也不变。

验证：`npm run typecheck` 干净，`npm run build -w @aihot/web` 成功，`node --test apps/web/tests/*.test.ts` 15 个全绿；`aihot_smoke_test` 那个空库上 `node scripts/smoke.ts` 两处改动前后各跑一次，两次都是 35/35，`/terms`、`/privacy` 的 `<h2 id="s1">` 照样出得来。rebase 时注意：`markdown.ts` 那两处正则上游要是改回来，冲突以本仓库为准——上游那个域名对派生站永远是外站。
