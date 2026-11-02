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
| 文件 | `packages/backend/src/config.ts`、`packages/backend/src/lib/url.ts`、`packages/backend/src/lib/http-fetch.ts`、`.env.example` |
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

**网页套件（`npm run build -w @aihot/web && node --test apps/web/tests/*.test.ts`）在这台机器上的基线是 51 条 / 50 绿 / 1 红**（2026-10-12 量）。这个总数这两天往上走过两次：10-12 晚些是 58/57/1，10-13 加了安静周那条真渲染用例以后是 **59 / 58 / 1**——**红的始终只有 WebKit `native-video` 那一条**，判回归按名字判，别拿总数当凭据。**这句在 2026-10-14 有一次量出来的例外，写在这里免得下次把它当成已修**：`hover still fetches article data, touches that move do not, and failed prefetch does not replace the current page`（`apps/web/tests/navigation-performance.test.ts:130`，等的是那条被故意设成 503 的预取响应）在**同一份 `cache.test.ts`（16521 字节，改硬那一版）的七次全量里红过两次**（09:04、09:10 各 59/57/2），随后连续五次全绿；`navigation-performance` 单跑 10/10、与 `cache.test.ts` 两文件对跑 22/22、把 `cache.test.ts` 换回 HEAD 那一版再全量跑也是绿的，所以既不是这一支改出来的，也不是「机器被拖累」（红的那两跑里同一个文件其余用例的用时与绿跑同一量级，只有 hover 自己那 32.5s 是 30s 超时）。**这条名字不在基线那 49 名里，车道那一跑也跑不到 `apps/web`**（`package.json:24` 的 `npm test` glob 只有 `tests/*.test.ts` 与 `modules/*/tests/*.test.ts`），但它下次再红就按这一句办：**先单跑复验，单跑必绿记偶发**，既不写成回归，也不写成已修。凭据、四条排除和那条**没证的怀疑**都在 regdocs §53。前提是本机装过 `npx playwright install chromium webkit`——**只装 chromium 不够**，缺 webkit 时 12 条会一起红成 `browserType.launch: Executable doesn't exist`。剩下 1 条：`WebKit: native video…`（这台机器上的 WebKit 放不出测试用的视频，同一个用例的 Chromium 版是绿的）。上一版记的 2 红里，`deep reading returns to its anchor…` **不是本站代码的问题**：断点其实在 `page.goBack()` 那一步，这台机器的 Windows 版 WebKit（UA 自称 Safari 26.5）在做「把列表换回来」的那次视图过渡时直接崩掉网页进程，同一串步骤在 Chromium 上全绿，把 `document.startViewTransition` 摘掉以后 webkit 也全绿——那条用例现在换用 Chromium 跑手机视口，断言一条没减（细节见 regdocs §42）。历史上还有过 4 条红，其中 2 条是测试自己写着点上游示例行业的分类「模型」「产品」，已按本站的 法律法规 / 新车发布 改掉。

**判断有没有引入回归，比对失败测试的名字，不要只看红绿。** 这 8 个必须在 Linux（CI 的 `.github/workflows/check.yml`）上跑绿才算过。

跑这套件时**不要设 `MODEL_CALLS_ENABLED=false`**（`COLLECT_ENABLED` 也留给缺省值）：测试的「不出网」靠的是 `tests/setup.ts` 把付费服务指到本地 HTTP 桩、把凭据目录指到不存在的路径，不是靠这个阀。带上它跑，20 个用例会以 `Model calls are disabled` 红掉，看着像大回归。AGENTS.md 里「开发和测试时保持安全阀关闭」那条要这样读：**别开采集与外发**，模型调用的开关在测试里是留给本地桩用的。详见 `regdocs/阶段一验收记录.md` 第 2 节。

**这条最容易踩进来的方式是 `source .env`**（2026-10-01 就这么红过一次：把 `.wt-dev/.env` 读进 shell 再跑，中途看到 25 个 `✖`，多出来的名字全是 `analyze` / `translate` 家族里依赖模型调用的用例，且都在十几毫秒内红掉；那次被我半途中断，末尾的失败详情没打出来，所以当场不能定罪）。**机制后来单独复现过**，同一棵库、同一个文件：`node --test tests/analyze.test.ts` 是 **8 个全绿**，`MODEL_CALLS_ENABLED=false node --test tests/analyze.test.ts` 是 **2 绿 6 红**，红的报错逐条是 `Error: Model calls are disabled (MODEL_CALLS_ENABLED=false)`。所以「红得多、红得快、红在依赖模型调用的名字上」就是这个阀被带进来了的样子，不是回归。开发机那份 `.env` 里 `COLLECT_ENABLED`、`MODEL_CALLS_ENABLED`、三个 `FEISHU_*`、`INDEXNOW_SUBMIT_ENABLED` 全是 `false`——那是给**真跑站点**用的安全配置，跑套件只需要 `DATABASE_URL` 一个变量。要对一下 CI 的口径就看 `.github/workflows/check.yml`：那个阀只出现在 `Smoke check of the built site` 那一步（第 60-62 行），`npm test`（第 70 行）继承的是 job 级的 `DATABASE_URL`，别的什么都没设。

`node --test apps/web/tests/*.test.ts` 在这台机器上原本 11 个里失败 9 个，同一个原因，已就地修掉（见下节），现在 15 个全绿（后来又为文案链接加了 4 个）。

**当前 `dev` 上的三个数字**（2026-09-30，`b5cd4b1`，用来判断改动有没有「跑出套件外面」，红绿仍以失败名字为准）：根套件 **158** 个（`d45c311` 实测 150 通过 / 2 失败 + 6 取消，红的正好是上表那 8 个名字）、web 套件 **15** 个全绿、`node scripts/smoke.ts` **38** 项（其中三项是 2026-09-30 加的报告页周期称呼检查，见 `regdocs/阶段一验收记录.md` 第 4 节）。`feature/report-issue-naming`（报告的期名跟着包走 + `tests/report-issues.test.ts`）合进来以后根套件是 **162** 个：154 通过 / 2 失败 + 6 取消，红的还是那 8 个名字。2026-10-01 在 `dev` = `043f1a3` 复量：根套件 **173**（165 通过 / 2 失败 + 6 取消，红名字与 `b40f6cd` 那次逐字相同）、web **15** 全绿、`node scripts/smoke.ts` **38** 项（空库与库里有真实日报/周报两种都跑过），`npm run typecheck` exit 0。2026-10-01 再复一次（`dev` = `38c1d7d`，`tests/source-health.test.ts` 长出第 5 条「额度花光不判信源死刑」以后，全新库 `aihot_bexempt_test`）：根套件 **174**（166 通过 / 2 失败 + 6 取消），红名字与上面那两次逐字相同。**同日四道门禁在同一个头上齐了一遍**（`dev` = `b3cd007`）：根套件 **174**、web **15** 全绿（先 `npm run build -w @aihot/web`）、`node scripts/smoke.ts` **38** 项全过（全新空库、生产构建的站点、五个安全阀全 false、api 日志里没有任何采集或模型调用的字样）、`npm run typecheck` exit 0（记下的是**代码头** `b3cd007`：把这几个数字写进来的那次提交只动 `.md`，没有任何测试读它们）。再往后一次：`dev` = `512cc4a`（推送门长出第 7 条以后）根套件 **175**（167 通过 / 2 失败 + 6 取消），红的还是那八个名字。最后一次：`feature/pack-rules-are-read` 头 `4ec9aea`（`tests/industry-pack.test.ts` 长出第 8 条：包里声明的门槛键要么被平台读掉，要么点名在「等哪一步」名单里）在全新库 `aihot_packrules_test` 上跑根套件 **176**（168 通过 / 2 失败 + 6 取消），红的八个名字逐字未变，`npm run typecheck` 同头 exit 0；合进 `dev`（`28e03fe`）以后那一个文件在 dev 上单跑 8/8。当天晚些时候**全量在 `dev` 本头上复跑了一次**（`dev` = `16cc7cd`，全新库 `aihot_dev176_test`）：**176 个测试、168 通过、2 失败 + 6 取消**，红的八个名字与分支头那次逐字相同，所以这几个数现在记在主线上，不只属于某个分支头。web 套件那一个是 `15` 到 **`16`**：`feature/empty-section-never-prints`（头 `0ba5bd6`，合入 `42b0249`）在 `apps/web/tests/cache.test.ts` 里加了一条真渲染的空板块用例，`npm run build -w @aihot/web` 之后 `node --test apps/web/tests/*.test.ts` **16 个全绿**、`npm run typecheck` 同头 exit 0，根套件当时没有重跑（改动只有一个 web 测试文件）；**当日最后一次量**是 `tests/source-health.test.ts` 长出第 6 条（反爬 403 的现状）之后，在分支头 `e3aebf4`、全新库 `aihot_403_test` 上跑出的 **177**（169 通过 / 2 失败 + 6 取消），红的八个名字与前每一次逐字相同，合入 `dev` 是 `579c2f4`；**合入以后在 `dev` 本头上复跑了一遍**（跑的时候主线头是 `adb96fb`，工作树里只有两处未提交的 `.md` 改动、没有任何测试读它们；全新库 `aihot_dev177b_test`，按 CI 的口径只设 `DATABASE_URL` 一个变量）：**177 个测试、169 通过、2 失败 + 6 取消**，红的八个名字与 `e3aebf4` 那次逐字相同（五个 SIGTERM + `tests/translate.test.ts` 的三个），所以 177 现在是主线上的数字，不只属于那个分支头。这中间**第一次尝试作废**：那次先把 `.wt-dev/.env` 读进了 shell，`MODEL_CALLS_ENABLED=false` 跟着进来，于是红了一大片依赖模型调用的用例——机制已按上一节那样单独复现过，不是回归。2026-10-03 再往后一次：`feature/name-the-fuses-the-code-charges`（分支头 `7d072ff`，全新库 `aihot_fuse2_test`）把 `tests/receipts.test.ts` 里那条**手抄七个服务名**的预算行检查换成从 `providers/*.ts` 里取（抄的那份已经漏掉 `llm` 与 `embedding`，而少一行 `budgets` 不是「上限 0」是**不受限**，见验收记录第 18 节）：**仍然 177 个测试、169 通过、2 失败 + 6 取消**，红的八个名字与前每一次逐字相同——总数不动是因为这条是**替换**一条用例而非新增，`npm run typecheck` 同头 exit 0，合入 `dev` 是 `1b72d72`。同日再一条：`feature/name-every-participation-mode`（分支头 `986c890`，全新库 `aihot_modes_test`）给 `tests/industry-pack.test.ts` 加了一条「迁移允许的信源参与模式必须都被代码点名」（判据形状的危险写在验收记录第 1 节那行：`publish.ts` 把除 `isolated` 之外的一切当作 public）——根套件 **178 个、170 通过、2 失败 + 6 取消**，红的八个名字与前每一次逐字相同（这次是**新增**一条，所以总数从 177 变 178），`npm run typecheck` 同头 exit 0，合入 `dev` 是 `7ec9a6a`。同日再一条：`feature/name-every-visibility-value`（分支头 `f6699b8`，全新库 `aihot_vis_test`）把那条「枚举允许的值必须被代码点名」从 `sources.participation_mode` 扩到 `publications.visibility`（两处都是朝开放侧掉：`availability.ts:16` 不是 `summary-only` 就答 `public`），并且把扫描的字符类放宽到带连字符——**只认小写下划线的枚举扫描会漏掉 `summary-only` 还照样全绿**：根套件**仍然是 178 个、170 通过、2 失败 + 6 取消**（这一条是**扩写**已有用例、没加用例数），红的八个名字与前面每一次逐字相同，`npm run typecheck` 同头 exit 0，合入 `dev` 是 `ef7594f`。**2026-10-06 补：178 这个数现在在 `dev` 本头也量到了**（头 `d8e7767`，全新库 `aihot_dev178b_test`，按 CI 的口径只设 `DATABASE_URL`）：**178 个测试、170 通过、2 失败 + 6 取消**，红的八个名字与前面每一次逐字相同（两份名单 `diff` 出来是空）。
这一条**第一次尝试作废过一次，原因与 10-03 那次不一样，值得单独记**：前一轮（库 `aihot_dev178_test`）红的是 **11 个**名字，多出的三个全在 `tests/publication.test.ts`（`an early release keeps the selected ledger in order`、`a withdrawal waiting behind an unreleased item leaves new snapshots at once…`、`minimal sync projection preserves snapshot fields, pagination bindings and ordered changes`，三条的断言都是「the sync watermark covers the released item」），而那十几分钟里我同时在开新 lane、跑 `npm install`、往工作树里提交 `.md`。判断走的是两步：把那一个文件单独在一棵全新库 `aihot_pub178_test` 上跑，**13/13 全绿**；再在什么都不并发的情况下整跑一次，交回基线那 8 个。**「单跑绿了」本身不足以结案**——那三处读的是投影水位与时间戳，并发 I/O 完全可能让它错位，所以结案的凭据是第二次整跑，而不是隔离跑。另一件顺手记下的事：**那次确认跑从 10-03 起跑、机器中途睡过去、10-06 才回完通知**，红的名单仍是基线那八个——本节说的「约 12 分钟」是各用例耗时之和，不是墙上时间。
同日多了一个文件：`scripts/audit-schema-enums.ts`（第 20 节那套扫描从 gitignore 的探针变成仓库里的工具，使用者点头新建；分支头 `e5dbfb0`，合入 `dev` 是 `2e03d32`）。它只读文件、永远 exit 0，**不进 `npm test`**，所以 178 这个数不因它变；`npm run typecheck`（含 `tsc -p scripts`）在 `2e03d32` 上 exit 0，而全仓唯一会读 `scripts/` 目录的那个测试文件 `tests/industry-pack.test.ts` 同头单跑 9/9。**四道门禁第二次齐在同一个代码状态**（2026-10-06，上一次是 `b3cd007`）：根套件 **178 / 170 通过 / 2 失败 + 6 取消**（`dev` = `b6af65e`，全新库 `aihot_dev178c_test`，红的八个名字与基线 `diff` 为空）、web **16 全绿**（同头，先 `npm run build -w @aihot/web`）、`node scripts/smoke.ts` **38 项全过**（同头、空库 `aihot_smoke178_test`、api 3011 / web 3021、五个阀显式 false、api 日志 3 行且 `grep -icE "collect|model|jina|dashscope|feishu|indexnow"` = 0）、`npm run typecheck` **exit 0**（`f5886cd`）。**`b6af65e` 与 `f5886cd` 之间只差两个 `regdocs/*.md`**（`git diff --name-only b6af65e..f5886cd`），所以四个数说的是同一个代码状态。**这一轮最值得学走的是跑法**：全量那十几分钟里，同机做 `npm install` 或新建 worktree，会让 `tests/publication.test.ts` 那三条读投影水位/时间戳的断言多出红来（第一次尝试就交出 11 个红名字）；那一个文件单跑是 13/13 全绿，但**结案凭据不是单跑，而是第二次什么都不并发的整跑**交回的基线 8 个。**同日第四次把四道门禁凑齐，而这一次是「复跑」而不是首测**：根套件在 `bcaed5f` 交出 **182 / 174 通过 / 2 失败 + 6 取消**、墙上 **13 分 27 秒**（全新库 `aihot_dev182d_test`，只设 `DATABASE_URL`、`MODEL_CALLS_ENABLED` 保持未设），**红的八个名字与上面 `eb4793d` 那次逐字相同**（五条 SIGTERM、一条 batch、三条 translate）；`npm run typecheck` 在 `3dfa614` **exit 0**；`npm run build -w @aihot/web` 在 `edfeccc` **exit 0**（`✓ built in 1.08s`）→ web 套件 **16 / 16**；冒烟在 `edfeccc` 的全新空库 `aihot_smoke182d_test` 上 **38 项全过、exit 0**，api 日志 3 行、活动短语 0 命中、3043/3053 收尾无监听，3001 上那个别人的监听照旧没碰。**四个数来自三个不同的头，但「同一个代码状态」这句仍然成立**，因为 `3dfa614 → bcaed5f → edfeccc` 之间**只有 `.md` 改动**——判据是那条「没有任何代码打开过 `regdocs/` 或 `FORK-CHANGES.md`」的 0 命中命令，不是「看着都叫文档」。**冒烟第一次是红的，红我的脚本**：`API_PORT=3043`、`WEB_PORT=3053` 单独成行、没 `export`，两个子进程各走默认端口，api 撞上 3001 那个不属于本轮的监听直接 `EADDRINUSE` 退出，web 落在 3000，于是 38 项全是 `fetch failed`——**下次看到「冒烟整批红」先 `cat` 那两个 server 日志**，两行日志比 38 个红字便宜。**给下一位的结论**：基线没动，还是 182 条、红 8 个名字，**只改 `.md` 的头不必重跑那 13 分钟**（但别把这条当定理，它成立是因为上面那个 0 命中）。

**2026-10-08：四道门禁第三次齐在同一个代码状态**，头是 `eb4793d`——第一个同时带着 `tests/notify-deliver.test.ts`（合入 `400e1d3`）与 `scripts/audit-divergence.ts`（合入 `6b1ce01`）两个新文件的头。根套件 **182 / 174 通过 / 2 失败 + 6 取消**（全新库 `aihot_gates182b_test`、只设 `DATABASE_URL`、墙上 13 分 41 秒、红的八个名字与基线 `diff` 为空）、web **16 全绿**（`npm run build -w @aihot/web` exit 0，`✓ built in 1.12s`）、冒烟 **38 项全过**（全新空库 `aihot_smoke182_test`、api 3042 / web 3052、五个阀显式 false、api 日志 3 行、收尾 3042/3052 无监听，3001 上那个不属于本轮的进程照旧没碰）、`npm run typecheck` **exit 0**。**四条跑法上的纠正，都是这一轮踩出来的**：**(a)** 冒烟时 `NODE_ENV=production` **只能给 `apps/web` 的 server**，给了 api 就撞上 `apps/api/src/main.ts:13` 的生产守卫（要么 `ADMIN_PASSWORD` ≥12 位，要么配飞书登录），那 30 项 502 是守卫在正常工作，不是站点坏了；**(b)** 「api 日志里没有任何采集或模型调用」这句要用**活动短语**去 grep（`collect (started|source)`、`model (call|request)`、`jina|dashscope|indexnow`），不要把服务名裸列——上一行那条 `…|feishu|…` 在崩溃日志上会命中错误文本里的「configure **Feishu** sign-in」，把 0 打成 2；**(c)** 门禁的 exit code 必须**单独成一条命令**去取——这一轮我把 `build_exit=1` 记成了「`$TEMP` 不能做重定向目标」，**2026-10-08 当天复跑当场推翻，改在这里**：`$TEMP` 就是 `/tmp`，同一个 `npm run build -w @aihot/web` 重定向进它 exit 0、日志 6305 字节、`✓ built in 934ms`；真相是那条链里 `diff` 先返回 1，把 `&&` 断在 build **之前**，**重定向从未执行**，而 `echo "build_exit=$?"` 是用 `;` 接在后面的，读到的正是 `diff` 的状态（最小复现：`false && node --version > /tmp/never.log; echo $?; ls /tmp/never.log` → `1` 且文件不存在）。所以「日志不见了」通常意味着写它的那条命令没跑，而不是路径有问题。同一行里的 web 套件却是**真跑了的**（`grep … | tail -2` 的退出码是 `tail` 的，把断链掩了过去），16 全绿照旧算数；**只有「build ✓」那半句当时没被量到**——它由紧随其后的复跑（同一头 `eb4793d`，`.data/web-build.log`，exit 0）与今天这一跑补上，结论没变，凭据换了。日志仍建议写进被 gitignore 的 `.data/`，但那是本仓库的规矩，不是 `$TEMP` 的毛病；**(d)** 数红名单时 `grep '^✖ '` 会把 runner 自己的 `✖ failing tests:` 小标题也算进去（182 那次就报成 9 个），要么 `grep -v "^failing tests:$"`，要么直接读汇总行——而汇总行在 npm 的输出里**不是** `^ℹ` 开头，等它完成要用 `grep -E "tests [0-9]+"` 这类宽匹配，我按 `^ℹ tests ` 等过一轮，白等 550 秒。

**2026-10-12 第五次同步（上游「只看未读」两条 cherry-pick，`15bc417` + `652bd6b`）以后，本机重新量了一遍**：`aihot-pg` 容器起来（`127.0.0.1:5433`），全新库 `aihot_sync1012_test`，只设 `DATABASE_URL` 一个变量 —— 根套件 **802 个 / 742 通过 / 55 失败 + 5 取消**，红名字 60 个（`.data/root-red-names-new.txt`）。**判断有没有回归用的是同名对照，不是这 60 这个数字**：把同一台机器上同步前的状态（`git checkout pre-sync-20261012-1502 --` 那 5 个文件、新测试文件移开）在全新库 `aihot_syncpre_test` 再跑一遍，**同样 802 / 742 / 55 + 5，两份名单 `diff` 为空**。本节上面那些 178/182 是 10-06 之前的根套件规模（fork 长大以后本机的数一直没重量过）。**口径仍然是服务器车道那 49 名（§48），这一轮因为传码的 ssh 被权限层连拦三次，改在本机容器上做了同机对照**（同步前后各一遍、红名字 `diff` 为空，只能证明「这轮没引入新的红」，不能顶替服务器车道那一次）——服务器那一道**当天已补上**（使用者授权后跑 `aihot_lane2_ci`）：**802 个 / 753 通过 / 49 失败 + 0 取消**，49 个红名字与 §48 那份基线**双向 `comm` 都为空**（存 `.data/red-server-new.txt`），所以这轮同步在标准口径下同样没有回归。

**这 60 个里有 12 个是这台 Windows 机器的环境项，不在服务器车道那 49 名基线上**：`tests/backup.test.ts` 的 8 条（tar / dump / 附件目录 / 打包重试）、`outbound direct keeps larger response headers confined to one host` 与 `outbound proxy …` 两条、`SIGTERM finishes the sent normal batch…` 与 `…misaligned batch…` 两条。反方向服务器多出的那条是 `every environment variable the code reads is listed in a template…`（那棵树没有 `.git`，见 §48）。所以对照要两边都做：多的名字要能指到环境，少的名字要能指到树。

**服务器车道上那一条「每个环境变量都写在模板里」红的是车道本身，不是站点**：`tests/architecture.test.ts` 用 `git ls-files -- *.env.example` 枚举模板，而 `/opt/aihot` 是 `tar` 解出来的树、没有 `.git`，那条命令在服务器上永远非零退出，所以这条**只在车道上红、在本机绿**（本机那份是同一个仓库的 git 检出）。判据：同一条命令在 `/opt/aihot` 里跑一次、在开发机仓库根跑一次，两边状态码不一样。不修的理由是它测的不是站点行为——把车道改成 git 检出动的是 deploy 的传码方式（`git archive | ssh`），那是另一件事、要另议；真要根治得让那条测试改成「不依赖 git 也能枚举模板」，那是所有站共同的改法，按 CONTRIBUTING 先在上游开 Issue，不在这里加分叉。

**web 套件在同一条同步后是 58 / 57 pass / 1 fail**（先 `npm run build -w @aihot/web`，exit 0）：比 10-12 早先的 52 多出的 6 条是上游新文件 `apps/web/tests/timeline-unread.test.ts` 的 6 条，全绿；唯一红仍是 `WebKit: native video waits for interaction…`。那个新文件里上游写的是示例行业分类 `ai-models`，本站 `industry/taxonomy.ts` 没有这一项，`npm run typecheck` 会直接报 `TS2322` —— 已按 AGENTS.md 那条「测试里用的是示例行业的分类」换成 `regulation`（`7cc370f`）。

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
| 「不动」今天有了数目（2026-10-03 补，详见 `regdocs/阶段一验收记录.md` 第 20 节） | 迁移一共建了 **61 张表**，其中 **12 张在 `packages`、`apps`、`scripts`、`tests` 里一次都没出现**：11 张就是这两个模块的（`lb_aliases`、`lb_models`、`lb_prices`、`lb_rankings`、`lb_runs`、`lb_scores`、`lb_snapshots` 与 `monitor_event_posts`、`monitor_events`、`monitor_posts`、`monitor_state`），第 12 张 `fx_rates` 是上游随 `0003` 一起带进来的、计划书从没提过它。命令：`grep -rn "monitor_posts\|monitor_events\|lb_runs\|lb_prices\|lb_snapshots\|lb_rankings\|lb_models\|lb_aliases\|lb_scores\|fx_rates\|monitor_state\|monitor_event_posts" packages apps scripts tests \| wc -l` → **0**；表名数目：`grep -rhoiE "CREATE TABLE( IF NOT EXISTS)? [A-Za-z0-9_]+" database/migrations/*.sql \| awk '{print tolower($NF)}' \| sort -u \| wc -l` → **61**（用 `$3` 会少数一张）。删表仍然是不可逆操作，这一行只是把「不动」从一句主张变成一个可核对的数 |
| 文档 | `docs/customize.md` 第 6 节改为「已删除」并保留删除清单，`docs/architecture.md` 的模块表去掉那一行（原来指向已删除的 `docs/leaderboard.md`） |
| 2026-09-30 复查这一项的 DoD | 「无残留调度/路由」重新走了一遍：`apps/api/src/routes/` 只剩 11 个文件、没有 `leaderboard.ts`；`apps/worker/src/schedules.ts` 里 grep `leaderboard\|monitor\|codex` 零命中；`apps/`、`packages/`、`scripts/` 全量 grep 只剩**一句注释**——`packages/backend/src/lib/http-fetch.ts:10` 把「榜单数据」当作出网流量的例子之一。它既不是调度也不是路由，为了注释去动核心管线文件要在原则 1 上开口子，所以留着；rebase 时看见这行不必以为模块没删干净。同日另两处**确实算残留**、已清：`tests/setup.ts` 还在给已删的额度监控喂 `MONITOR_MODEL`（全仓没有第二个引用，删掉），`industry/README.md` 的表还在列已经不存在的 `features.ts` |
| 复查时修掉的文档 | `industry/README.md` 的表还在列 `features.ts`，`docs/customize.md` 第 6 节的写法读起来像那个文件还在。两处都改成「行业包里没有『模块开关』这一项，文件本身不存在」。**`AGENTS.md` 第 7 行也还列着「模块开关（`features.ts`）」**——那是给 Agent 看的说明，改不改由使用者点头 |

为删掉它们而改动的上游文件（rebase 时逐个核对）：`apps/api/src/{app.ts,routes/{admin,og,site,static,v1}.ts}`、`apps/web/app/{routes.ts,components/shell/nav.ts,routes/admin/{layout,runs}.tsx,routes/{agent,more}.tsx}`、`apps/worker/src/{main,schedules}.ts`、`packages/backend/src/{admin/runs,editorial/models,notify/deliver,operations/alerts,publication/{llms,sitemap}}.ts`、`packages/contracts/src/{http-policy,taxonomy}.ts`、`packages/backend/package.json`（去掉两个只有榜单用的依赖）、`scripts/{seed,smoke}.ts`、`.env.example`、`NOTICE`、`README.md`、`assets/README.md`。

---

## 阶段一 · 1.2 测试去污染

`tests/` 里 13 个文件原本把示例行业的分类 key、标签、公司名、模型名和阈值写死在断言里，换了 `industry/` 包就会红一片。现在这些值从规格里读：`CATEGORY_KEYS`、`ITEM_TYPES`、`CATEGORY_TAGS`、`TOPIC_TAGS`、`ENTITIES`、`TAG_SYNONYMS`、`IDENTITY_LEXICON`、`SELECTION.thresholds`，以及提示词渲染出来的原文（用来认「这一步是谁」而不是靠一句中文标题）。

| 项 | 内容 |
|---|---|
| 文件 | `tests/{analyze,analyze-shutdown,default-model,events,listings,materials,media-performance,publication,receipts,report-lead,signals,sources,x-shards,url}.test.ts` |
| 2026-09-30 又找出一处**不会变红的污染** | `tests/translate.test.ts`（三处）与 `tests/translate-shutdown.test.ts`（一处）往 `analyses` 直插 `category='ai-models'`——示例行业的分类，本包没有这个 key，但那一列没有约束，所以换包以后它照样绿。现在四处都取 `CATEGORY_KEYS[0]`，与 1.2 其余改动同一个写法；改完全仓 11 条 `INSERT INTO analyses` 的分类值全部来自包（`grep -A2 "INSERT INTO analyses" tests/`）。同一轮把两处「示例行业的公司与产品」桩文本换成车载说法：X 引用推送那条原来是 `Introducing Claude Sonnet 5.5`（配 Anthropic / Boris 的假账号），现在是座舱监测规程；列表页解析那条原来是 Amodei / Ed Sheeran 那组标题，现在是 WP.29 修正案、驾驶员监测标配、NOA 事故回溯。**断言的结构一个没动**：哪条链接算行首、重复 URL 要去重、`allowUrlPrefixes` 只收 `/2`、五个候选数照旧。**2026-10-16 补**：上游 `540c477` 新增的翻译重试用例又把 `'ai-models'` 三处硬编码了回来（随 `25ea05c` 同步带入），已按同一写法改为该文件现成的 `${CATEGORY}` 常量——下次同步若该文件冲突，ours 侧的分类值一律取包 |
| `docs/customize.md` 那句「测试里还写着示例行业」已经不成立 | 1.2 之后 `tests/` 的分类、标签、阈值都从包里取，`tests/industry-pack.test.ts` 还会核对包与库/公开契约一致。那句话现在改成了「例子从包里取，新加的也要从包里取」，免得下一个改包的人以为还要再去扫一遍测试。`AGENTS.md` 第 24 行还留着同一句旧话，那是使用者的文件，没动，等点头 |
| 特意留下的假公司名 | `tests/analyze.test.ts:238` 和 `tests/listings.test.ts` 用的 `Loxfield …` 是**编造的**供应商名，而 `analyze.test.ts:239` 断言的正是「本包词表里认不出这个名字」（`matchEntityIds(...) == []`）。这里要的是「不在表里的名字」，换成真实车企或机构反而让断言失去意义，所以不改 |
| 只改测试 | 平台代码一处没动；测试用到的常量上游都已导出 |
| 顺带发现的冲突 | `tests/sources.test.ts` 有一条断言把 P1 修掉的旧行为当成正确行为（分片 X 源不认 URL 前缀），已与 P1 同一个分支改掉 |
| 2026-10-13 第二次去污染（服务器车道 49 名基线里的 A 簇 36 条） | 1.2 那一轮扫的是**断言里**写死的分类、标签与阈值，漏掉了**假模型回答里**写死的同一批值——它们不报错，只是让一条评判链路整个跑不完。这次按报错原文逐条定位后换掉 18 个文件：**(1)** 内容类型——`understand` 步骤的 `itemType` 是 `z.enum(ITEM_TYPES)` 且**没有 `.catch`**，示例行业那几个名字（`model_release`、`product_launch`）被包拒掉，`analyze`、`analyze-consistency`、`analyze-kill`、`analyze-missing-evidence`、`analyze-shutdown`、`processing-recovery`、`default-model` 一起倒；现在统一从 `tests/analysis-steps.ts` 的 `LAUNCH_ITEM_TYPE` 取（按名字在 `ITEM_TYPES` 里找，包里改名就在导入处抛，不再伪装成「模型给的回答不能用」）。**(2)** 分类标签与主体公司——`normalizeTags` 只认词表、`subjects` 只认 `ENTITIES` 的 id，`模型发布/推理/开源` 与 `anthropic` 在本包里都不存在，被静默丢掉以后 `analyze.test.ts` 那两条 tags 断言就没了依据；`enforceIdentity` 那两条换成包里的身份词典（华为／英伟达↔NVIDIA）。**(3)** 主题实体——`anthropic`、`kimi`、`minimax`、`openai` 不在 `industry/topics.json`，`loadTopicPage` 返回 null，`!` 解引用一起倒；换成比亚迪／吉利／华为／市场监管总局与国标委／ADAS 视觉感知，并把「拉丁名挨着中文要认、嵌在长词里不算」（Metadata/Meta → SACD/SAC）这条原样保住。**(4)** 两处按本站包重定：`category-corrections` 的「主打发布」计数（`RELEASE` 在本包是 null，日报根本不报这个数，断言改成「没有这一项」而不是改成 0）与 `content-publication` 的发布代表（`owner_entity_id` 必须是名录里的 id，否则 `priority` 一律 3、`pickRepresentative` 只剩下比分数那一步）。**rebase 时要逐个核对**：`tests/{analysis-steps,analyze-missing-evidence,content-publication,topic-membership,independent-selected}.test.ts` 这 5 个文件在本轮之前与上游逐字相同，现在起是分叉文件；其余 13 个本来就在分叉名单里 |
| 2026-10-13 同日：安静周那期的网页凭据 | `apps/web/tests/cache.test.ts` 加了一条（`3cee52e`）：一份 `lead: null`、`sections: []`、`overview` 取自 `REPORTS.quiet.weekly.paragraph` 的 `ReportDetail`，走真产线 server 渲染，断言 `/weekly/<期>` 打得开、页面印的确实是包里那句、一个 `id="s-N"` 版页都没有、不借日报的安静标题、报头收口不给 `REPORTS.metricUnits` 的任何单位名。**测试里零文案字面**，所以使用者改 `site.ts` 的安静句它照绿。这个文件正是 §28.5 那次「同步把网页凭据冲掉」之后搬回来的那一处，下次同步仍要按名字复查它。**同日反证把这一条本身改硬了**：原先那句「页面印的确实是包里那句」写作 `body.includes(quietLine)`，是**打不红的**——把三个会把 `overview` 写进 HTML 的地方（安静期的 `Overview`、报头 `dek`、`meta description`）先逐个、后一起换成占位，用例照样 12/12 绿，因为 React Router 把 loader 数据序列化进 `<script>`，整份文档里那句话永远在。现在断言读的是 `printed(body)`（先剥掉 `<script>`，再取那一个 `<article>`，并且断言这个区域真的存在，防止切片切出空串冒充通过）：真树 12/12 仍绿，而只把 `Overview` 那一个写入点换成占位就必然红（实测 11 过 1 红，红的正是这一条），反证用的占位随后逐字退回（`git diff` 对那两个组件为空）。**同日同一文件里另一条也被咬红过**：第 254 行那句「有板块的那一节按它自己的名字印出来」原先判整份文档，改成读 `printed()` 仍绿——把节自己的 `<h2>`（`ReportPaper.tsx:396`）换成占位还是绿，因为同一个字符串在页面上有**第二个**写入点（「本期版面」目录的 `{p.label}`，:360），也就是说这条断言一直在证明「目录列过这个名字」而不是「那一节按自己的名字印出来」。现在它去读那个元素：先断言 `<h2 id="s-1-t">` 真的存在，再判它的文本等于 `CATEGORIES[0]!.label`；占位挂着时 11 过 1 红、退回后 12/12。规矩：**服务端渲染的页面里，「读者看得到 X」的正向断言不判整份文档**（loader 载荷被序列化进 `<script>`，X 作为数据永远在），负向的那几条读整份反而更严，保留。 |
| 新行业加的检查 | `tests/industry-pack.test.ts`：`industry/sources.json` 的每个配置项必须是该 kind 实现的（`unsupportedConfig` 为空），owner 必须是 `ENTITIES` 里的、tier 必须在 `SELECTION.thresholds` 里有阈值，标签近义词与兜底标签必须指向规格里存在的标签；另加一组「四方一致」的契约检查——从 `database/migrations/` 读出的 CHECK 枚举（`sources.kind`、`reports.kind`）必须与包内用到的 kind（且只能是 `rss`/`web_list`/`json_list`）和 `site/public/openapi-v1.json` 公布的报端点一致，`SELECTION.regulationCategories` 必须是 `CATEGORIES` 里的分类，还有最后一条：`SELECTION` 的每一个键要么被 `packages/`、`apps/`、`scripts/` 读掉，要么在那条测试的「等哪一步」名单里点名列出（2026-10-01 加，正因为 `regulationWeight` 那种「包里有数、平台不乘」容易被读成已实现）。读的是迁移文件而不是活库，这个文件仍然不连库、不出网 |
| 2026-10-14 下午：第 34 格（`'industry'`/`'ai-models'` 落在分类列） | 使用者点头「换」——`.data/item34.patch` 打在四个测试文件（`tests/{alerts,report-outlets,seats,discovery-updates}.test.ts`）上：每文件两行，一行 `import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy"`，一行把 `'industry'` / `'ai-models'` 换成 `${CATEGORY_KEYS.at(-1)!}`。这四个文件本轮之前与上游逐字相同，现在起是分叉文件。行为一字不变的证据是 `sectionOf(CATEGORY_KEYS.at(-1)) === sectionOf(null) === "行业动态"`（`packages/backend/src/reports/edition.ts:21-23` 的 `DEFAULT_SECTION = SECTION_OF.industry ?? SECTION_ORDER.at(-1)!`，本包 `SECTION_OF` 没有 `industry` 键所以走 `SECTION_ORDER.at(-1) = 行业动态`；`customer` 是本包 `CATEGORIES` 的最后一个 key，`sectionOf(customer)` 也落在这一节）。`npm run typecheck` exit 0。 |
| 2026-10-14 下午：第 37 格（`模型发布` 12 处 → `车型发布`） | 使用者点头「全换」。`grep -rn 模型发布 tests/` 之前 12 行 / 5 个文件，今天改完 `grep -rn 模型发布 tests/` 空。**其中 `tests/recall-pool.test.ts` 与 `tests/withdrawn-recall.test.ts` 改之前与 `upstream/main` 逐字相同（`git diff upstream/main --` 各 0 行）**，这一笔之后是**新分叉文件**——同步时要按名字复查；另外三个（`analyze-missing-evidence` / `grouping-reliability` / `report-outlets`）本来就是分叉文件，这次不新开面。**基线红名单会跟着改 3 条名字**：`analyze-missing-evidence:51-52` 那三条子测试名由 `JSON.stringify(changes)` 现拼（`{"bodyText":"…"}`、`{"excerpt":"…"}`、`{"xPost":{"text":"支持","quoted":{"text":"…"}}}`），正文换「车型发布」以后双向 `comm` 会显示「3 条消失 + 3 条新增」——**看着像回归 3 条，实际是改名**；车道复跑时按这一条记账，不算新红。 |
| 2026-10-14 下午：第 38 格（牌子名 90 处 + 分类键 7 处 → 车包实体） | 使用者点头「全换」，与第 37 格同一性质（AGENTS.md「测试夹具换成新行业对应项」的尾账）。`.data/scan-example-industry-residual.mjs` 现算：改前 107 处——牌子名 13 词 90 处 16 文件、分类键 3 词 7 处；改后牌子名 **90 → 6**、分类键 **7 → 5**（两处剩余都有明说：6 处全部在 `tests/markdown-body.standalone.test.ts`，那是 `packages/backend/src/content/markdown.ts:44,72` 按 `openai.com` 域名分派的清理规则的**行为凭据**，换域名等于让断言空转——要清它得连 `packages/` 一起改，不在本格范围；5 处是 scan 的子串误报：`multipart` 与 `tooltip` 里的「tip」，不是任何分类键的值，不动。**基线 49 名里带着这些词的：0 个词**，本格不产生改名红，比第 37 格更没有回归面。**本轮新开 9 个分叉文件**（此前与上游逐字相同）：`analyze-news-identity`、`materials`、`report-lead.standalone`、`sources.standalone`、`url-identity.standalone`、`video-source-body.standalone`、`web-render-recovery.standalone`、`x-article`、`x-shards`——同步时按名字复查；`markdown-body.standalone` 因此**保持与上游逐字相同**。已分叉的 5 个（`agent-public`、`content-publication`、`pool-relevance`、`signals`、`translate`）不新开面；`apps/web/tests/navigation-performance.test.ts` 按约定不在本格范围。实体/产品名全部取自包内：比亚迪（byd）、华为（huawei，问界/AITO）、博世（bosch）、Mobileye；GPT-6.1 Sol→汉 EV 旗舰版、Dots→汉 EV 改款、Claude Sonnet 5.5→问界 M9、OpenAI Reader 那组夹具未动。`tip`/`paper`/`world-labs` 三个分类键命中里，`#paper`→`#news`、`amd-world-labs`→`bosch-mobileye` 已清，`tip` 即上面那 5 处误报。generic 那 10 处（voice/tutorials/benchmarks/openai.com/教程实践）**按判据不动**——抹掉只会让下一次同步的差异变大而无收益。验证：`npm run typecheck` exit 0；`bash .data/standalone-local.sh` 判据过（standalone 范围 2 条基线红本机实测绿，其余失败只有那两条已知 outbound libuv 环境红）；`bash .data/offline-guards.sh` 全过。 |
| 2026-10-14 深夜：第 35 格 / 1b（`REPORTS.quiet` 周月分两句，kind 分支从此可测） | 使用者明确「35 我看不太懂，你让 subagent 全面审查后给出建议你进行参考决定」——这一格是 AGENTS.md「读者文案由使用者本人定」的一次授权例外，例外本身记在这里。**改的东西**：`site/site.ts:218-220` 三支 quiet 里 `daily` 不动、`weekly` 变成「`subjectAfter("北京时间 {start} 至 {end} 这一周，信源都盯过了，没有值得单独说的", "大事")`。」、`monthly` 同形但「这一周」→「这一个月」。**为什么要分两句**：分之前两支逐字相同，`packages/backend/src/reports/compose.ts:255` 那个 `REPORTS.quiet[kind].paragraph` 从外部完全测不出——把 `kind` 硬编码成 `"weekly"`、把索引整个删掉、包里两支换成同一个值，读者拿到的 overview 一个字节都不变。分成两句之后 kind 分支第一次有凭据。**新增两条断言**（都零文案字面，从包里现取；日后使用者改 `site.ts` 措辞仍绿）：**(a)** `tests/report-issues.test.ts` 一条「安静刊取的是包里对应那一支，不是另一支」——`packFragments` 把两支模板按 `{start}/{end}` 切片，断言 `storedOverview("weekly", WEEK)` 含周模板的每一段、不含任何月专属段，反之亦然；再加一条前提守卫 `assert.notEqual(weeklyTemplate, monthlyTemplate)` 免得两支重新合成一句让本断言空转。**(b)** `apps/web/tests/cache.test.ts` 一条安静月报——新增 `QUIET_MONTH = "2026-10"` 与 `quietMonth: ReportDetail`，两条 api mock 路由；沿用现成的 `printed(html)`（先剥 `<script>`，再取那一个 `<article>`），判读者看到的是**月那句**、**不是周那句**——`report-issues` 测 `compose.ts:255` 从包取的那句对不对、`cache.test` 测那句真的走到读者眼前的 HTML。**不新开分叉面**：`site/site.ts` 是本仓从上游 AI 示例改成车载行业时逐字重写的那份、`tests/report-issues.test.ts` 早过了本仓自己那两条期名/成刊判据（这张表 §53 上面几段已经点过）、`apps/web/tests/cache.test.ts` 就是本表 §28.5 那一次「同步把网页凭据冲掉」之后按名字搬回来的那一个（就在上一行），三个都已经在下次同步要按名字复查的名单里，本格只把每个文件各加长一段。**验证**：`npm run typecheck` exit 0；`bash .data/offline-guards.sh` **33 条判据全过**——其中 `quiet-render` 那条守卫把三支 quiet 按 `compose.ts` 真正用的那个 `windowSentence`（从源文件按字节切出来、不重抄）逐期号渲一遍，判三条硬约束（`{start}`/`{end}` 各**只**出现一次、半句里没写死「车载」、整句必须带「车载大事」否则是没走 `subjectAfter`），自带 5 条坏候选 + 2 条好候选（A 周与 B 月）的反证；A 与 B 在这一版落进包里以后都过这三条，所以「三条都过」是它自己说的。`rehearse-lane` 按既有约定**主动跳过**（`.data/red-after-49-clear.txt` 在位，彩排不许覆盖车道真名单）。 |
| 2026-10-14 下午：熔断当正文判词（并行那条会话的 `cce52a9`） | 登记的是**别的会话的活**——不是这一轮的改动，也不是我写的；这条之所以进这张表，是因为 `check-fork-changes-coverage.mjs` 扫 `red49-baseline..HEAD` 时把它算进「会被下一次同步覆盖」那一堆。**它到底改了什么**（照 `git show cce52a9 --stat`）：`packages/backend/src/content/extract.ts` 让 `BudgetExceededError` 从「吞掉返回 null」改成抛给 worker；`packages/backend/src/jobs/content.ts` 在 worker 那侧收到熔断时把 `processing_state` 打回 `new`、`processing_retry_at` 按提供窗口自己那格、**不占用 attempts**、`body_status` 保持 `pending`（不烧次数、不落 `unconfirmed`），与 `content.sweep` 已有的重新排队对齐。**归使用者与那条会话判断**：要不要拆批、要不要 tag、什么时候上线由它自己或使用者来；我不动这三个文件，也不与本轮 34/37/38/35 那四批混合提交。 |

---

## 阶段一 · 1.3 / 1.4 行业包

改的全部在 `industry/`（站名与文案 `site.ts`、分类与标签 `taxonomy.ts`、主题 `topics.json`、信源 `sources.json`、提示词 `prompts/*.md`、门槛 `selection.ts`、品牌 `brand/`、条款模板 `pages/`、更新日志 `changelog.json`），按上游约定不算分叉，rebase 时整目录以本地为准。**这句从 2026-10-13 起要说两半**：上游 `d5d9645` 把站点自己的东西搬进 `site/` 以后，本站自己的文件分在两处——`industry/` 只剩行业知识（`taxonomy.ts`、`topics.json`、`sources.json`、`prompts/`、`selection.ts`），站名文案、每一步的模型、品牌、条款页、`public/`、`changelog.json` 都在 `site/` 下（这次搬家记在 `docs/deploy.md:163`）。「整目录以本地为准」的范围因此是 `industry/` **和** `site/` 两棵，只盯 `industry/` 会把 `site/site.ts` 与 `site/pages/*` 这些真正被代码读的那几份漏在外头；`90b06bb` 已经把 `industry/` 下那批旧布局副本删干净了；服务器上那棵树上的同名文件**这一跑不会跟着删**（`git archive | tar -x` 只覆盖、不删除），它们在不在位要靠 ssh 量，我没量过。

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
| `json-miit-zcwj`（工信部政策文件搜索） | 开发机上取到过真实 JSON，结果数组路径与 `deploytime`（epoch 毫秒）已核对；按 `deploytime` 倒序（`sortFields` 得是合法 JSON：少一个 `}` 接口不报错，只是不排序，返回的就全是几年前的存量），并配了 `ingestNoiseFilter` 挡住通信/无线电类公告 |
| `rss-euroncap-news` | 有效 RSS 2.0，取到过条目 |
| `json-cncap-pingjia` | **未验证**：那是 POST 接口，开发机上 GET 探不到；`enabled=false`，等后台「试抓」通过 |
| `web-catarc-news`、`web-catarc-wp29` | **未验证**：列表选择器是按常见页面结构写的猜测；`enabled=false`，等「试抓」通过 |

需要真实浏览器的 EUR-Lex / IVISTA 不属于声明式配置，走 `POST /api/ingest/items`（上游已有该路由与 `external` kind）。

### 与 DEV-PROMPT「采集适配器裁决」表的差异（信源清单归使用者定，先记在这里）

| 站点 | 裁决表 | 现在的包 | 差在哪 |
|---|---|---|---|
| MIIT | `rss × 2`（RSSHub 镜像 + 原生 RSS） | `json-miit-zcwj`，`json_list` 打它的政策文件搜索接口 | 这台机器上没有跑 RSSHub，原生 RSS 又没核实过，搜索接口是取到过真实返回的那一个。2026-09-30 当天先得出「它不认 `sortFields`」，那个结论是错的：配置里的 `sortFields` 少了一个右花括号，接口收到解不开的 JSON 不报错、只按自己的默认顺序回 2004—2019 的老文件。补正以后同一个接口按 `deploytime` 倒序，第一条就是当天的征求意见公告，`previewSource` 15 条全是近期的。**这条现在是活源**，裁决表那两个 `rss` 更不用找了 |
| C-NCAP | `json_list × 5` | `json-cncap-pingjia`（`enabled=true`，2026-09-30 试抓通过：20 条、都有日期、最新 2026-09-03），加上同接口的 `json-cncap-cgcaps` / `json-cncap-cicaps` / `json-cncap-ccrt`（各 20 条、20/20 有日期，先 `enabled=false`） | 那一天早先写「另外四个探不到」是没找对门：不用四个端点，是同一个 `api/getPingjiaList` 换 `bodyJson.type`。接口只认 `cncap`/`cgcap`/`cicap`/`ccrt` 四种 type，别的一律 404（`ev`、`cnev`、`safety`、`chassis`、`micro` 等都试过），所以裁决表的 ×5 到四条为止；第五条要不要用别的端点补，得再看站点的其它接口 |
| UNECE / WP.29 | `rss` + `web_list` | 只有 `web-catarc-wp29`（`web_list`）。2026-09-30 那次「声明式不可用」也是配置问题：URL 指在 WP.29 简介页 `/jj/`，`itemSelector: "li"` 自然只命中导航。改指工作动态页 `/gzdt/` 并配 `ul.wpcanhuilist li` + `span` 以后，同一台机器、不带浏览器取到 9 条带日期的条目 | UNECE 自己的 RSS 仍未核实：`unece.org` 四个候选 feed 地址在这台机器上全部 403（回的是 Cloudflare 质询页），要官方源得换出口或按裁决表走推送器。中汽中心这页最新一条停在 2024-03-18，所以保持 `enabled: false`，留不留由使用者定 |
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
| `scripts/audit-schema-enums.ts` | 第 20 节那套「迁移里每个 `CHECK (列 IN (…))` 枚举、它的每个允许值有没有被非注释代码点过名」的扫描，2026-10-06 由使用者点头做成仓库里的工具。只读文件（迁移 + `packages/backend/src` + `packages/apps/scripts/tests` 的表名引用），不连库、不出网、不写盘，**永远 exit 0**（一个没人点名的值不等于缺陷，判断留给往 CHECK 名单里加值的人）。跑法 `node scripts/audit-schema-enums.ts`；它自带前提检查，扫到的引号名少于 50 或认不出 `json_list`/`summary-only` 就直说「扫描本身坏了」。它不进 `npm test`，只被 `tsc -p scripts` 编 |
| `scripts/audit-divergence.ts` | 2026-10-06 那套「我们的分叉对上游现在的树」的分类做成工具：`main..dev` 的每条路径（A/M/D 三半）按上游对同一路径做了什么分类——两边都改、上游搬走、上游删了、上游没碰、上游也删了（同向）、同名各建；再把改名阈值压到 10% 配一次，专门逮「上游搬走了而两边又各自重写」那类**合并时不会报冲突**的静默接管（第一次跑就逮到 `industry/site.ts`→`site/site.ts` 14% 与 `tests/url.test.ts`→`tests/url.standalone.test.ts` 34%）。只读 git，不连库、不出网、不写盘，**永远 exit 0**；口径可用 `DIVERGENCE_BASE`/`DIVERGENCE_US`/`DIVERGENCE_UPSTREAM` 换。跑法 `node scripts/audit-divergence.ts` |
| `scripts/deploy-direct.sh` | 本机直连部署（不用 Docker）的一键脚本，`c6a30a3` 建在本仓库里。**上游 `main` 没有这个文件**（`git ls-tree main -- scripts/deploy-direct.sh` 空），所以下一次同步不会盖掉它，改它也不构成分叉。2026-10-13 在解包之前加一道**会自己拒绝**的守卫：扫 `git ls-files --others --directory` 的顶层条目，扣掉 tar 真正排除的那些，剩下有名字就 exit 1——起因是 2026-10-12 那次把 `server-backups/` 里 12 MB 整库 dump 传上了共享机，而本机今天还留着 `vibe-sources/`、`vibe_images/`（`tar` 不认识 `.gitignore`，被 gitignore 的目录照样出门）。守卫的跳过清单必须与那句 tar 的 exclude 一致（分叉了要么漏出门、要么误拒）。对齐与证明都在 `.data/`（本机纸面工具，不入库）：`check-deploy-readiness.mjs` 从脚本里抠出那句扫描命令与那几个 `case` 分支的**原文**跑一遍，`rehearse-deploy-guard.sh` 把 `ssh/tar/npm/node/bash` 全换成桩做行为学证明（命中时 trace 必须 0 行＝一次都没连服务器；把守卫删掉做反证则必须放行）。故意要带上那两个目录的写法是 `DEPLOY_ALLOW_UNTRACKED=1 bash scripts/deploy-direct.sh` |
| `DEPLOYMENT.md` | 上面那一支的读者侧文档，`c6a30a3` 建在本仓库里、**上游 `main` 也没有**（`git ls-tree main -- DEPLOYMENT.md` 空），登记进来不是为了防覆盖，而是让「这一轮的分叉面在哪些文件上」这一张表读全——同一 commit `64c7692` 既改了脚本也改了这一页（守卫那一段的说明跟着写），下一次 cherry-pick 时**这一页与 `scripts/deploy-direct.sh` 一起看**。历史里被改过四次：守卫那条 (`64c7692`)、车道模板与被锁在数据库门外那一段 (`629b950`)、四条根因 (`33c62a7`)、按现状重写并删掉明文管理员密码 (`5a0a60f`) |

**⚠ 这张表记的是「我们在 `dev` 上加了什么」，不是「部署那条线上有什么」（2026-10-12 查分支落差时补）。** 上面这几行里的 `scripts/doctor.ts`、`scripts/audit-schema-enums.ts`、`scripts/audit-divergence.ts`、`database/migrations/0040_model_budget_rate.sql`，连同 1.7 的 `packages/backend/src/projection/bitable.ts` + `0041_feishu_projection.sql` + `tests/feishu-projection.test.ts`，**在当前部署的 `dev-synced` 上都没有**（`git diff --name-status --diff-filter=D dev dev-synced` 交出 23 个只在 `dev` 上的路径；上游 `main` 里也没有这些文件，所以不是上游给了等价物）。直接后果有两条：**生产的 `budgets` 现在跑在上游默认 `llm=300 次/分钟`**（网关限 40 RPM），以及**阶段一 DoD 那句「飞书投影与门户一致」在部署线上不成立**。逐条后果与处置选项记在 `regdocs/需求对照审查-2026-10.md` §3，等使用者定「搬回来还是改口径」。在这一条定下来之前，本表里那几句「跑法 `node scripts/doctor.ts`」这类话只能在 `.wt-dev` 那个工作树里兑现。**2026-10-15 更新（方案 a 已执行）**：`dev-synced` 整体并入 `dev`（`--no-ff`，`03806ab`），上述文件现在都在主线 `dev` 上，本表从「两张分叉的表」变回「一张主线的表」；「部署线上没有」那半句仍然成立——服务器跑的仍是并入前的代码，待下一次上线才失效。

**这张表最容易漏，所以配一条命令**：`git diff --name-status main..dev | awk '$1=="A"{print $2}' | wc -l` 现在交出 **28 个新增路径**（2026-10-08；2026-10-06 那次是 26，多的两个就是 `tests/notify-deliver.test.ts` 与 `scripts/audit-divergence.ts`——**这类数会随每一次合入漂，所以本文不再把它当结论写，以 `node scripts/audit-divergence.ts` 为准**），分组是这样（同一行管道里换 `awk` 就能数出来）：`regdocs/` **8**（本项目的计划与记录）、`tests/` **9** + `apps/web/tests/` **1**（补测，各节自己列了文件）、**`industry/` 是 0**——换行业包改的全是上游带来的那批文件：`git diff --name-status main..dev -- industry` 是 **20 个 `M` + 1 个 `D`**（删掉的是 `features.ts`，1.1 那两个开关），一个都没新增，所以「整目录以本地为准」就够了。剩下 **8 个**是真正要盯的：`FORK-CHANGES.md` 自己、两个迁移（0040 在本表，0041 见 1.7）、`packages/backend/src/projection/bitable.ts`（见 1.7）、`scripts/tsconfig.json` 与 `scripts/opentype.js.d.ts`（见「构建 · `scripts/` 进了类型检查」）、`scripts/doctor.ts`，以及上面那行新加的 `scripts/audit-schema-enums.ts`。**以后新增文件就往这张表补一行，并拿那条命令对一遍名单**——上游 rebase 时要核对的正是这份。

**核对的两句命令，以及这张表的一个读法陷阱。** 分叉的**三**半各由一条命令定死：新增是 `git diff --name-status main..dev | awk '$1=="A"{print $2}'`（今天 **26**），改动是同一句换成 `$1=="M"`（**103**），**第三半是删除，换成 `$1=="D"`（101：1.1 摘掉那两个模块带走的东西）。这一半原先根本不在「两半」这个口径里，2026-10-06 复量时才发现——而 modify/delete 恰恰是 rebase 里唯一必须人来判的那一类，它只出现在第三半。** 完整的一条命令是 `git -c core.quotePath=false diff --name-status -M main dev`，2026-10-08 复跑交出 **232** 条（**28** `A` + 103 `M` + 101 `D`）。**别信这里写的数，跑工具**：`node scripts/audit-divergence.ts`——2026-10-06 那次数是 230/26，两天里就变了两次，每次都变在合入的新测试与新脚本上，这正是它被做成工具而不是写成散文的原因。工具还额外把改名阈值压到 10% 再配一次，专门逮「上游把文件搬走了、两边又都重写了内容」那类合并时**不会报冲突**的静默接管（一跑就逮到两条：`industry/site.ts → site/site.ts` 相似度 14%、`tests/url.test.ts → tests/url.standalone.test.ts` 相似度 34%）。只读 git，不连库不出网，永远 exit 0。**这三半各自与上游现在的树怎么对，2026-10-06 逐个分过类，记在 `regdocs/阶段一验收记录.md` 第 23 节**：我们动过的 129 个路径里 86 个两边都改、30 个上游没碰，而 1.1 删掉的 101 个文件里 100 个上游自己也删了。陷阱在于**本文的名单是花括号压缩写的**——`publication/{items,v1,stories,reports,publish,llms}.ts`、`tests/{analyze,events,…}.test.ts` 这样一行装六个文件。所以「用脚本按 basename 去 grep 本文，凡没命中的就是漏记」这个办法**会大量假报警**：我今天就用它报了 18 个「没记」的，逐条查下去 18 个全在花括号里或被归类为包内容（`industry/` 是整目录以本地为准，不需要逐个点名）。真要机器核对，得先把花括号展开（`echo` + `braceexpansion`，或者老老实实人工对），或者把本文改成一文件一行——那会让这张表长三倍，不值得。**结论是：命令用来数总数与查漏掉的目录级分组，具体某个文件在不在账上，仍然靠人读那张表。**

**这两句命令在这个仓库里还有一个共同的坑：git 会把中文路径转义打印。** `regdocs/` 下的文件名是中文，`git diff --name-only` 默认（`core.quotePath` 为真）把它们打印成带引号的八进制转义，行尾就成了 `"` 而不是 `.md`。所以任何**按结尾匹配扩展名**的用法都会假报警：今天量「自四道门禁那个代码状态以来是不是只动了 `.md`」，`git diff --name-only f5886cd..dev | grep -vc '\.md$'` 交出 **2**，看着像有两处代码改动；加 `-c core.quotePath=false` 重跑，那 2 行就是 `regdocs/待使用者定的事.md` 与 `regdocs/阶段一验收记录.md`，真实答案是 **0 个非 `.md`**（`wc -l` 不受影响，所以 26/103 那两个总数一直是对的；受影响的是打印出来的字符串和结尾匹配）。往这两张表的命令前抄 `git -c core.quotePath=false` 就对了。

### 对上游文件的修改

| 文件 | 改动 | 原因 |
|---|---|---|
| `packages/backend/src/operations/alerts.ts` | **2026-10-18 核对：已不在分叉面上。** 分叉当初在这里新增 `source.failing` 告警（`today` 级）；上游后来自己做了同一件事且更全——`sources.failing\|unstable\|silent\|quality\|details.<mode>`，全是 `later` 级、走每日汇总；合并时上游那组接管了这个位置，分叉那一版已不存在，现在 `dev` 的这个文件与 `upstream/main` 逐字相同（`sources/health.ts`、`providers/receipts.ts` 也一样） | 上游原本只有「网站停止收录」这种整体判断：一个法规发布源连续失败时其它信源仍在更新，网站看起来一切正常，只在周报表里露一次面。信源失败是阶段一要求必须告警的三项之一（实施方案 §1.6）。**差别只剩紧迫度**：分叉原本要立刻报，现在进每日汇总 |

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
| 对上游文件的修改 | `packages/backend/src/config.ts` 加 `feishuBitableEnabled`；`packages/backend/src/notify/feishu.ts` 把 `API` 与 `tenantToken` 导出给投影复用，并让 `FEISHU_API_BASE` 可以指向本地 stub（测试用的缝）；`apps/worker/src/schedules.ts` 加 `projection.bitable`（`*/15 * * * *`）；`.env.example` 加三个键 |
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
| `site/brand/nameplates/*`（五张 svg + `index.json`） | 用 `node scripts/nameplates.ts <noto-sans-sc 包目录>` 重新生成（字体不是依赖：`npm pack @fontsource/noto-sans-sc@5.3.0` 解开即可）。viewBox 变宽是「车载」两个方块字比 "AI" 占位多；2026-10-13 `aac5e18` 又发现线上那四张一直是上游示例行业的字标，按本包 `subject` 重生成了一遍 |
| `industry/prompts/{summarize-article,rules-self-contained-title}.md` | 标题与摘要这两条线的示例行业说法换成车载的：核心主体从「模型名/产品名」改成「机构名/标准号或法规文号/车型名」，teaser 例子从 "v2.1.159"/"Small is a feature" 换成 "GB 44496—2024"/"No.013628"，兜底上位词改成「一项整车安全类强制性国家标准」，动作边界里的「开源/上线」换成「实施/生效/批准/公开征求意见」（`b46c205`） |
| `industry/prompts/{group-definitions,group-batch,group-signal,content-understanding,identity-context}.md` | 归组与理解那几条：SAME_OCCURRENCE/SAME_STORY/UNRELATED 的例子从「同一产品线的多个基座版本」换成「同一标准的不同部分、同一版 C-NCAP 规程的乘员保护与行人保护两个分册」，新增价值的判据从「新价格/平台上架」换成「新的适用范围或实施时间变化、明确可迁移的合规做法」，实体白名单补进网信办、交通运输部、TC260，「防止公司/模型身份张冠李戴」改成「机构/公司」（`b46c205`） |
| `industry/prompts/{story-digest,translate-body,translate-post}.md` | 综述与翻译两条线：事件类型例子改成「一次法规或标准的变化、一起召回、一项测评的前后报道」，译者身份从「科技新闻译者」改成「熟悉汽车与法规领域的专业译者」，可保留英文原名的类别从「公司、产品、模型」改成「机构名、标准号与法规文号、车型与芯片名」（`b46c205`） |
| `site/pages/{terms,privacy}.md` | 两页不再是上游那份模板：表头填上版本 1.0 与生效日期 2026-10-13，联系方式改成站内反馈页 `/feedback`，页首定位按本站实际写法改过，「来源方更正与下架」那节的对象从「来源方」改成发布机关/测评机构/车企/媒体，使用数据那节写清哪些用途可以直接用、哪些要先取得同意，接口频率一节按本站三个公开出口重写，免责补上「模型生成的法规摘要不构成法律意见」。**两处还欠着**：两页的 `运营主体` 都写「待补充」，那是使用者本人的信息（`cf9c009`） |
| `industry/package.json` | `exports` 去掉 `./pages/*` 与 `./brand/*` 两条子路径——那两个目录已经不在了，留着是把断掉的出口挂在售卖图上（`90b06bb`） |

**旧布局的副本已经清掉，别再跟着同步长回来**：上游 `d5d9645` 把站点自己的东西搬进 `site/`，本仓库 `industry/` 下那批副本（`brand/`、`pages/`、`site.ts`、`changelog.json`）`90b06bb` 全删了，测试与包的 `exports` 一起指回 `site/`。这十四条是**删除**，不参与上面的登记；要盯的是反方向——哪一天同步把这些旧路径**加回来**，就会出现两份站名文案和两份条款页，而 `site/` 那份才是代码读的。核对方法记在 `regdocs/阶段一验收记录.md`：搬目录之后按**新路径**比 blob 哈希，光看 `git log --follow` 会说「改名了、没事」。

**保留的「AI」**：`Score.tsx` 的「AI 评分」、`item.tsx` 的「AI 导读」「正文 · AI 翻译」、`story.tsx` 的「AI 综述 / AI 根据报道生成」。这些说的是这一段内容出自模型，是机制披露，不是行业词，换行业之后仍然成立。

---

## 阶段一 · CI 与 README 里跟着包走的数字

| 文件 | 改动 |
|---|---|
| `.github/workflows/check.yml` | docker 作业的「库里应该有 18 个信源」改成从 `industry/sources.json` 现读现比（`grep -qx "$EXPECTED"`）。18 是上游示例包的信源数，车载包是 6 个，写死的数字第一次推 CI 就会红 |
| `README.md` | 「仓库带了 18 个公开的海外 AI 资讯源做示范」按本仓库实际内容改写，不再报上游的示范名单 |
| `.github/workflows/check.yml`（安全阀那一步） | docker 作业里那句 `sed` 之后加了两条 `grep -qx` 断言，要求 `.env` 里 `COLLECT_ENABLED=false` 与 `MODEL_CALLS_ENABLED=false` 确实成立。原因：这两个阀**默认是开的**（`COLLECT_ENABLED` 读作「不等于 false 就是开」，`MODEL_CALLS_ENABLED` 在 `config.ts:67` 缺省 true），而 compose 的 `env_file: .env` 会把 `.env` 灌进容器。哪一天上游给 `.env.example` 那两行加了注释或改了写法，`sed` 就静默不匹配，CI 里的 worker 会真去抓国标委/工信部/Euro NCAP/C-NCAP 并真调模型。本地验证过两个方向：照现在的模板两条断言都过；把模板里那行改成注释，断言就红。FEISHU_* 与 INDEXNOW_* 不加断言，因为它们缺省就是关，且投影在缺凭据时先答 `unconfigured` 再发请求 |
| `docs/deploy.md`、`README.md` 的 clone 地址 | 两处都写着 `git clone https://github.com/KKKKhazix/AIHOT.git`，那是**上游示范仓库**：照本文做的人会 clone 到上游那个 AI 站，不是本仓库。改成 `<你自己仓库的地址>`，不替他定仓库叫什么 |
| 两个安全阀在部署文档里根本没说清 | `.env.example` 原来只写「关掉就不抓信源、不调模型（调试界面时有用）」，没写**默认是开的**；`docs/deploy.md` 整篇一次都没提这两个阀。结果第一条 `docker compose up` 就会真抓真调（模型按 token 计费）。现在模板、`docs/deploy.md`、README 三处都写明缺省开、先看界面就改 false，并且说明关掉之后后台「试抓」照旧可用（那是管理端主动取一次、不写库）。改完复核过 CI 那两条 `grep -qx`：它们匹配的是 `KEY=` 整行，加注释不影响；`scripts/init-env.ts` 是逐字复制模板再填密钥（第 13、19 行），所以模板行为不变 |
| docker 作业本地真跑过一遍（2026-09-30，`a8ca39e`） | 整条走通：build → 35 项冒烟 → 库里信源数 = 包里的 6 → 容器网络里 `doctor` 通过。**差一行配置就会红**：`/api/mcp` 那一项要求 `.env` 里有 `MCP_ALLOWED_HOSTS=web`，CI 那句 `echo` 就是专门加它的，手工照 `docs/deploy.md` 部署的人若要跨容器访问 MCP 也得设。跑完 `down -v` 收尾，全程没改平台代码。见验收记录第 13 节 |
| deploy.md 里「第一次导入的一百多条资料大约半小时处理完」 | 「一百多条」是上游 18 源示范包的量，跟着包走不了。改成不报数量的说法（第一次启动导入 `industry/sources.json` 里启用的信源，每条要预筛、评分，入选的再写标题摘要） |

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

`tests/ingest-push.test.ts`（新增文件，2026-09-30 六条、2026-10-01 起七条）覆盖 `POST /api/ingest/items`——1.4 的「要真实浏览器的信源做成外部推送器」和阶段三的原文推送都从这门进。平台侧 `packages/backend/src/ingest/items.ts` 与 `apps/api/src/routes/ingest.ts` **一行没动**（`git diff --stat main..dev -- packages/backend/src/ingest apps/api/src/routes/ingest.ts` 为空），只是第一次有人测它。第 7 条测的是**现状而不是应当如此**：一个共享 `INGEST_TOKEN` 可以点名任何在册信源并把条目写进它名下、顺带刷新它的 `last_ok_at`/`last_fetch_at`；这条把触达面钉住是为了让「要不要按 R9 加 `source_prefixes`」成为一个看得见代价的决定，不是把它伪装成已经修好的 bug（计划书规则表的对照与这条落差记在 `regdocs/阶段一验收记录.md` 第 14 节）。

---

## 阶段一 · 读者拿得走的两处上游名字

改完 `links.portal` 以后把「不署旧产品的名」这条重新走查了一遍：把 `scripts/smoke.ts` 走的那 35 个对外出口**逐个**抓下来数旧名字出现几次（34 个 GET + 一次 MCP `initialize` 握手）。结果是 **17 个 HTML 页面各有一处、且都只有同一处**——内联主题脚本里读的那个 `localStorage` 键 `aihot-theme`；其余 18 个出口零处：6 个 `/api/v1/*`、两个 feed、`llms.txt`、`robots.txt`、`sitemap.xml`、`manifest.webmanifest`、`openapi-v1.json`、`/api/health`、三张图（`/og/site.png`、`/icon.png`、`/favicon.ico`，图里没有嵌名）、以及 MCP 握手（`serverInfo.name` 是 `regwatch`，工具名 `regwatch_get_daily` 等）。再往页面之外找，读者**保存到本地的文件名**里还有两处。

| 文件 | 改动 |
|---|---|
| `apps/web/app/lib/markdown.ts` | 判断「这个链接是不是本站的」用的是写死的旧域名正则（两处 `https://aihot.news`）。现在读 `siteUrl()`（`SITE_URL`，没设置时回落到包里的 `SITE.defaultUrl`）。不改会有两种坏法：本站的绝对链接被当外站加 `target="_blank"`；谁的条款文案里一旦提到那个旧域名，会被剪成站内路径、链到本站一个不存在的页面。**当前 `industry/pages/` 里还没有绝对链接，所以这一步在屏幕上不改变任何东西**——它是拆雷，不是救火 |
| `apps/web/tests/markdown-links.test.ts` | 新增四个用例：站内绝对链接→相对且不开新窗口、只写域名本身也算站内、外站与那个旧域名→原样保留并 `target="_blank" rel="noopener noreferrer"`、本来就写成路径的不受影响。第 2 轮之前它是红的（旧代码把 `https://aihot.news/daily` 变成 `/daily`） |
| `apps/web/app/features/item/PosterSheet.tsx`、`apps/web/app/routes/starred.tsx` | 分享海报「保存图片」与收藏页「导出本地数据」的文件名是 `aihot-<id>.png`、`aihot-local-data-<日期>.json`——文件名是站名唯一能离开页面、进到读者电脑上的地方。改成 `${SITE.name}-…`，名字跟着包走 |

留在原地的 `aihot` 是**工程标识符**，不是署名：`@aihot/*` 工作区包名与导入、CSS `@keyframes aihot-*`、`localStorage` 键（`aihot-theme` 等五个）、会话缓存前缀 `aihot:list:` / `aihot:groups:`、`x-aihot-ssr` 请求头、原始数据里的 `_aihot` 键、`vite.config.ts` 的插件名、`publication/feeds.ts` 的局部变量。判据是「不用 devtools 就看不到」；改它们只会加 rebase 冲突面，对外出口读得到的一句话也不变。

验证：`npm run typecheck` 干净，`npm run build -w @aihot/web` 成功，`node --test apps/web/tests/*.test.ts` 15 个全绿；`aihot_smoke_test` 那个空库上 `node scripts/smoke.ts` 两处改动前后各跑一次，两次都是 35/35，`/terms`、`/privacy` 的 `<h2 id="s1">` 照样出得来。rebase 时注意：`markdown.ts` 那两处正则上游要是改回来，冲突以本仓库为准——上游那个域名对派生站永远是外站。

---

## 阶段一 · 采集：标题里的行内标记不再变成空格

`packages/backend/src/lib/text.ts` 的 `stripTags` 把每个标签换成一个空格——读正文是对的（`</p>`、`<br>` 确实是边界），读标题不是：国标委的搜索接口会把命中的词包进 `<sacinfo>…</sacinfo>`，于是「汽车、挂车及汽车列车质量参数测量方法」采集回来变成「汽车 、挂车及 汽车 列车质量参数测量方法」，读者在站点、RSS、`/api/v1`、MCP 和飞书投影里看到的就是这些洞。关高亮试过：`highlightFields=` 与 `isHighlight=false` 它都不理，只有不带关键词的查询是干净的，可那也就不过滤行业了。

改法是往 `lib/text.ts` 加一个 `stripInlineTags()`（同一套实体解码，标签直接消失、不留空格；`stripTags` 的行为一个字没动），采集器里凡是**标题**都换过去：`packages/backend/src/sources/json-list.ts` 的 title 与 excerpt、`packages/backend/src/sources/rss.ts` 的两处 title。正文 `bodyText` 仍旧走 `stripTags`。覆盖在 `tests/sources.test.ts`：本地桩回一条带 `<sacinfo>` 的标题和一条带 `<em>` 的标题，断言前者拼回原样、后者本来就有的空格保留。

验证：`npm run typecheck` 干净，`node --test --test-concurrency=1 --test-timeout=120000 tests/sources.test.ts` 12 个全绿；再用管理端那个 `previewSource` 打真站点，`json-sac-gb` 第一条是「汽车、挂车及汽车列车质量参数测量方法」。rebase 时注意：这是**改了采集器行为**的一处，上游若把 `stripTags` 用别的地方也调了，以本文件的这一段为准来复核。已经存进库的标题不会被这条改动追改（标记只在采集那一刻起作用），但真机采集还没开过阀，库里没有这种历史数据。

---

## 阶段一 · 报告的期名也从行业包来

`packages/backend/src/reports/compose.ts` 把周报/月报的期名拼成 `${SITE.name} 周报 · 2026-W38`——「周报」两个字写死在平台层。派生站别处的对外文案都已经走 `industry/site.ts` 的 `withSubject()`（`/api/site/*`、`llms.txt`、OG 图、MCP、导航、报头），只剩这里。现在改成 `${withSubject(kind === "weekly" ? "周报" : "月报")} · ${key}`，与 `publication/reports.ts` 里日报已有的 `${withSubject("日报")} · ${key}` 一致，也与 web 那份「`KIND_LABEL` 出裸词、由调用处包 `withSubject`」的写法对上：站点上期名的可访问名本来就是 `车载周报 · 2097 年第 30 周`，API 给的却是 `RegWatch · 车载行业动态 周报 · …`。

**改法不是只改一行。** 读的那一层 `publication/reports.ts:periodicHeadline()` 用一条正则认「这只是期号，不是这一期的大事标题」：`/^.+ [周月]报 · \d{4}-/`——要求「周报」前面有一个空格。`withSubject()` 在主体词以汉字结尾时**不加空格**（「车载周报」），所以只改拼法不改这条正则，期名就会被当成标题发到 `/api/v1/reports/weekly` 每一项的 `headline` 上（站点、内容 feed、`llms.txt` 都读它）。正则会改成按期号后缀认：`/ · \d{4}(-(W\d{2}|\d{2}))?$/`，既不依赖周期词也不依赖空格，旧拼法存下来的行照样认得出。这条不是推演出来的：把正则换回旧的，`tests/report-issues.test.ts` 第二条立刻红，报 `actual: '车载周报 · 2097-W30'`、`expected: null`。

**新增 `tests/report-issues.test.ts`（4 条，全程不出网、不调模型）。** 空的候选窗口也会成刊（`composePeriod` 只在有条目时才 `chatJson`，`modelFor()` 不碰网络），所以这些都能离线钉住：期名跟着包、同一周重跑只留一行且旧内容进 `report_revisions`（`revision` 到 2）、相邻两期在索引里按期号倒序、期名不会被当标题。写它时踩到一个必须记给后来人的点：`reportIndex()` 那份索引在进程内缓存 60 秒（`freshMs: 60_000`），**先读一次索引再插行，第二次读是看不到的**——所以三期都在 `before()` 里造好，索引只读一次；这条也在测试文件头写了。

**第一次看到有真实期次时的报头。** 库里造一期 `2097-W30`，api 起在 3021、web 起在 3000，采集与外发各阀关着：`/weekly/2097-W30` 回 200，`<h1 id="report-start">` 里是 sr-only 的「车载周报 · 2097 年第 30 周 · 07.22 — 07.28」，后面那段报头 SVG 有 19 个带 `d="M…"` 的 `<path>`（就是真的字形轮廓，不是空壳），整段 `aria-hidden`、可访问名交给 sr-only 那句；期号那句「第 1 期」也出得来。以前这一条只能验到「报头字按包里的 `subject` 重新生成」的脚本层。看到仍然不是人眼——这台机器出不了图（`take_screenshot` 不可用），所以像素层面的确认还欠着。

**顺手给这个新页面做了一遍旧品牌走查**：整页 26264 字节，`aihot` 只出现 1 次，就是已经认定不改的那个 `localStorage` 键 `aihot-theme`（判据见上节）。

**安静的那一期照样成刊（2026-10-13，`480f52f` + `5f5ef5c`）。** 本节前面那句「空的候选窗口也会成刊」**在写下时并不成立**：那 4 条 `tests/report-issues.test.ts` 当时在服务器上车道里是红的，死在 `before()` 的同一条 `throw`——`composePeriod` 沿用上游的假设「一期内总有精选条目」，本站 §49 以后安静日照常成刊，于是**安静周必然撞这句**（写下这条时它仍是潜因，不是实测：§53 量到的 73 次失败全是同一个日报 `daily:2026-10-12`，W41 那一周还没过完——真到第一个安静周，就是每轮 compose 重试一次、每次失败一次）。现在判据与 `composeDaily` 对齐：**一期里一份日报都没有**是停机，照旧抛（等补跑）；**有日报但都没带条目**就照常成刊（`entries: 0`、不调模型、不花额度），导语存在 `overview` 里。**配置形状跟着变了**：`site/site.ts` 的 `REPORTS.quiet` 从「daily 的 `title` + `paragraph`」扩成按报别三支，周报月报只留 `paragraph`（那两期的刊名跟着包走，`5f5ef5c` 删掉了我起草时多配的两支没人读的标题）。因此 `docs/customize.md` 那条说明改了（那个文件本来就是分叉的）；**`docs/deploy.md:94` 那句没改**——它是上游那次发布的升级说明、与上游逐字相同，动它等于给下次同步新开一处冲突面，本站的形状变更以本条为准。凭据：`tests/report-issues.test.ts` 4 条（车道上 4/4 绿）+ `apps/web/tests/cache.test.ts` 那条真渲染（安静周那份 `lead: null`、`sections: []` 的报纸打得开、印的是包里那句、没有任何版页）。

**一处没动的示例行业残迹**：`compose.ts` 里 `modelsReleased: perSection.get("模型发布/更新")` 取的是**示例行业**的栏目名，车载包没有这一栏，于是这个指标恒为 0，而 web 的 `features/report/format.ts` 把 0 藏掉（`metrics[k] > 0` 才显示）——读者看不到，但它是平台层里最后一处按示例行业栏目名取数的地方。要不要把「今天有几个新模型」这类指标从派生站上删掉是使用者的决定（属于「报头该炫耀什么」），所以这里只记不动。rebase 注意：`compose.ts` 那行期名与 `reports.ts` 那条正则是**一对**，只合一半就会把期名当标题发出去。

---

## 构建 · `scripts/` 进了类型检查

`scripts/` 不在任何一个 tsconfig 项目里（`packages/*`、`apps/*`、`tests` 各有一份，脚本没有），所以那 12 个脚本只有**跑起来**这一道关。这件事在有冒烟脚本以前没什么要紧，现在要紧：`scripts/smoke.ts` 是 CI 里唯一在没有内容的库上跑的一步，2026-09-30 起它还担着一条验收（报告页要按包里的说法叫自己的周期）——脚本自己写错一个类型，`npm run typecheck` 一声不响，要到跑站点那一刻才发现。

补法是三样东西：`scripts/tsconfig.json`（`extends: ../tsconfig.base.json`、`include: ["*.ts"]`，与 `tests/tsconfig.json` 同形）、`scripts/opentype.js.d.ts`（唯一报错的来源就是 `opentype.js` 没有类型，声明里只写 `nameplates.ts` 真正用到的那几个成员：`parse`、`Font.getPath`、`Path.getBoundingBox`、`Path.toPathData`）、以及 `package.json` 的 `typecheck` 里在 `tsc -p tests` 后面加的一段 `tsc -p scripts`。CI 的 `Typecheck` 那一步在冒烟之前，所以这一条从此在 GitHub 的 runner 上也生效。

验证：`tsc -p scripts` 干净，`--listFiles` 里 `smoke.ts` 与 `nameplates.ts` 都在（不是只收了一个空目录），并且往 `scripts/` 里放一个 `const wrong: number = "x"` 会红（`TS2322`）、删掉以后又绿——这一道关是真的会拦人的。`npm run typecheck` 整条链（contracts→backend→api→worker→tests→scripts→web 的 typegen+tsc）跑完同样是干净的。rebase 注意：`package.json` 那一行上游也可能改，合并时保住 `tsc -p scripts` 这一段。

---

## 阶段一 · 信源健康度怎么变成 `failing`（补测）

`collect.ts` 的健康度是一只纯 SQL 状态机（成功 → `ok` + `fail_count=0` + `last_error=NULL`；失败 → `degraded`，连续 5 次 → `failing`；退避 `interval × (fail_count+2)`，6 小时封顶），运营看的就是这一列，`doctor` 和告警都读它。以前它只在两处**间接**出现：`tests/alerts.test.ts` 用 `UPDATE sources SET health='failing'` 把状态摆出来再验告警，`tests/collection.test.ts` 只管 cursor 与 backlog——也就是说把 5 改成 50、或者让失败顺手把 cursor 写掉，没有任何测试会红。

`tests/source-health.test.ts` 用一台本地 HTTP 桩补上这几条，其中一条值得单说：**退避用的是失败之前的 `fail_count`**（同一条 UPDATE 里右侧取的是旧值），所以第一次失败等的是两个间隔而不是三个。测试注释里写明了这点，否则下一个人会以为差一天。预算花光那条分支（`${budget}` 为真时健康度与 `fail_count` 都不动、重试定在 15 分钟后）2026-10-01 也钉住了：拿 `r.jina.ai` 路由的 `web_list` 列表当付费采集，`JINA_BASE_URL` 指到同一个桩，把 `jina` 的 `per_day` 归零，`checkBudget` 在任何请求发出去之前就抛——**原先记的「要再搭一套 socialdata 桩才好补」是错的**。这里踩过一个坑值得留名：`jina` 出厂额度是每分钟 5 次，不先把它撑开，用来铺垫的那四次真失败会被预算自己挡掉，前提假了而断言照样绿。同一段 SQL 在 `collectXShard` 与 `sources/mp.ts` 里还各有一份副本，没有健康度用例——按 DEV-PROMPT 的采集裁决表这个包既不配 `x_search` 也不配 `mp_account`，**同一天更晚长出的第 6 条钉的是另一件事**：一台返回 403 的桩——反爬今天与「网站彻底死了」记的是同一本账，五次就判 `failing`，退避也一样，而错误对象里那个 `status` 没有任何代码读。那是**现状而不是主张**（附录A 的 X-09 要的是相反方向，改不改在 `regdocs/待使用者定的事.md` 第 21 条等他答）；它的敏感性也验过：把桩的状态码换成 500，只有这一条红、其余五条不动。所以那是有意留的边界，补法记在验收记录第 8 节。

---

## 阶段一 · 同步把两处 fork 侧改动盖掉了（2026-10-12 复发，已找回）

`tests/reports-feed.test.ts` 5 条红只是表象。根源是 10-08 那次同步把**两份已经定过的改动**还原成了上游的样子，第三次踩同一个坑（前两次的记录见「主题与品牌」与「Mimo 主题」两节）。

| 项 | 内容 |
|---|---|
| 症状 | `reports-feed` 5 条挂在旧路径 `/api/v1/reports/weekly\|monthly`；对外出口里 `"aihot"` 又回来了 |
| 先量再判 | 线上 curl：`/api/v1/weeklies` **200**、`/api/v1/reports/weekly` **404**；`git cat-file -e origin/main:tests/report-outlets.test.ts` 成立；`V1_OPERATIONS` 给具名一期的是 `max-age=300`（fork 曾写 3600，同步换成了上游的表，那是 CDN 的决定，不是测试的） |
| 找回 1（CT-5） | `v1Period` 在**上游的形状**上补齐内容馈送：`lead`（导语）、`overview`、按编辑顺序 `storyOrder` 的 `order`、`sections[].items`、`highlights`；`v1Periods` 索引补 `kind`/`key` |
| 找回 2（改名） | `publication/{agent,publish,reports,stories,v1,llms}.ts` 与 `site/public/openapi-v1.json`（22 处）的 `links.portal` 一起改回来；按名字边界，`feeds.ts` 里那个局部变量 `aihot`、`_aihot` 配置键、`aihot:*` 本地键**不动** |
| 一处判断归谁 | 我第一次恢复时把撤下的条目「标记但留在 issue 里」，5 条上游测试因此红（撤走的东西在公开出口留下了字）。CT-5 的规格原文只要「有序条目 + 分节 + 导语」，从没要求「标记撤回」；上游用 `.filter(ok)` 且带着写这条不变量的测试 ⇒ **采用上游的不变量**，fork 那条 `withdrawn === false` 的断言改成断言不变量本身，`agent.ts` 的 `periodAnswer` 跟着跳过空分节 |
| 验证 | `reports-feed` 6/6、`report-outlets` 20/20、`mcp-publication` 4/4、`publication` 22/22、`agent-public` 2/2；车道全套 796/746/50，红名比上一轮少一个、**新增零**（详见 `regdocs/阶段一验收记录.md` §41） |
| 下次同步怎么合 | 报端点认上游的 `weeklies\|monthlies`，**内容字段**保住这一节说的这几个；`links` 的键名以 `portal` 为准，冲突时不要照抄 `aihot` |

---

## 阶段一 · 后台「金标与门槛」：校准第 1 步不再开 JSONL 文件

| 项 | 内容 |
|---|---|
| 原问题 | `docs/selection.md` 的第 1 步要人从一张 JSONL 草稿里逐行把 `"TODO"` 改成判定，改完还要自己拼命令；草稿由 `scripts/gold-samples.ts` 生成，页面里没有地方看「今天库里的分数与人工判定差多少」 |
| 改动 | 新表 `gold_labels`（迁移 `0085_gold_labels.sql`，一条 `CREATE TABLE`）+ `packages/backend/src/admin/gold.ts` + 4 条 `/api/admin/gold*` 路由 + `apps/web/app/routes/admin/gold.tsx`，后台「系统」组里多一项「金标与门槛」。判定 `select/reject/either` 连同**录入那一刻**的门槛、模型平均分、是否入选、提示词版本一起存，`updated_by/at/version` 供审计与 `architecture.test.ts` 的「谁写的」检查 |
| 页面给什么 | 标注细则（三态各怎么给、按这条资料本身该不该选、五个维度写在哪个文件、先改标准再动门槛）＋ 库里现有分数与人工判定的一致程度（准确率/完整准确率/查准/查全/F1/覆盖率/多选漏了）＋ 每档门槛 ±6 的扫描 ＋ 待标逐条卡（原文与原文页在前，「模型怎么说」判完才展开）＋ 已标注表 ＋ 不一致清单（点一行去「内容诊断」） |
| 不花钱的那条线 | 页面**不调模型**，比的是库里已有的分数；付费的新鲜评测仍旧只有 `node --env-file=.env scripts/eval-selection.ts --gold <导出的表> --split development`。「导出金标表」是 `application/x-ndjson` + `Content-Disposition`，行形状与 eval 读的完全一致 |
| 删掉的 | `scripts/gold-samples.ts`（分层抽法与三分之一留验搬进 `goldBoard()`，两处会漂的表成了一张）；`scripts/eval-selection-core.ts` 搬进 `packages/backend/src/editorial/selection-metrics.ts`（git 认成 rename），脚本和后台读同一份实现。`.data/gold.draft.jsonl` 那 75 行全是 `TODO`，没人标过 ⇒ 作废不丢工作 |
| 为什么在框架层而不是 `modules/` | 模块的 `http` 插口只拿到 `FastifyInstance`，`adminHandler`（会话 + CSRF + `actorOf`）在 `apps/api`；做成模块要么重复一遍后台鉴权，要么先给框架加通用插口。它的另一半 SelectBench 本来就在框架里（`admin/selectbench.ts`），这半个是它的采集侧 |
| 两处真 bug 怎么被抓到的 | ① 行接口声明 `sourceTier` 而 SQL 别名是 `source_tier`：`goldBandOf()` 读到的分级永远是 `undefined`，**所有条目都会被算成 `unscored`**，`tsc` 的 6 处不一致背后是它。② 车道一条断言 `0.5 !== 0.333`：扫门槛时把预筛拦下的条目当成「没答上」掉出了分母，查全率因此比库内判定好看 ⇒ 拦下就是每个门槛下都不选，并钉住「扫到今天的门槛 = 上面那组数同一个分母」 |
| 验证 | `tests/admin-gold.test.ts` 6/6（分段边界、快照与 version、审计里的理由、一致程度与扫描同一个分母、导出的行、抽签稳定、路由的 CSRF/400/404/下载）；`npm run typecheck` 干净；`apps/web/tests/admin-performance.test.ts` 多了一条**真浏览器的页面测试**（细则在页面上、这一页只读 `/api/admin/gold` 一个接口、「模型怎么说」默认折着、点了判定才展开并 POST 到后台路由） |
| 已部署（2026-10-12） | 生产库 `0085` 到位（20ms、事务内），api/worker/web 重启，`links.portal` 已在 `/api/v1/items`、`/api/v1/selected/snapshot`、`/openapi-v1.json`（22 处）生效，smoke 全绿。**台账快照用 `refreshSelectedPayload()` 重发（`publish.ts:224`）**——不要用 `publishArticle`（它会排 `notifySelected`/`prepareMedia`，等于往群里推 92 遍），也不要写 SQL 改存好的 JSON：最新一条带旧键的 92 条刷成 91 条，按 `seq` 折叠后的当前态里旧键 0 条；历史行仍带旧键，那是变更流该保留的历史 |
| 下次同步怎么合 | 这 6 个路径上游没有，同步会把它们**留在树上但把同批框架文件里的接线（`routes.ts`、`admin/layout.tsx`、`apps/api/src/routes/admin.ts` 的注册）盖掉**——§25 的清单要一起核；被删的 `scripts/gold-samples.ts` 与 `scripts/eval-selection-core.ts` 可能被同步带回来，回来了就按本节的搬法再删一次 |

## 2026-10-15 首次 main→dev 同步核对（`25ea05c`）

上表预言的两件事在首次同步里都应验且都按预案处理：

- **接线没被盖**：admin/gold 六路经 §25 清单核对完好——`apps/web/app/routes.ts:54`、`apps/api/src/routes/admin.ts` 四个注册、`apps/web/app/routes/admin/layout.tsx:45`。
- **被删文件没有以文件形态回来**：`466ceb5` 把 `scripts/eval-selection-core.ts` 改名进 `packages/backend/src/editorial/selection-metrics.ts`（R091），merge 沿改名把上游 `3c69b49` 新增的 `parseSelectionGoldJsonl`/`selectionGoldPool`/`SelectionGoldRow` 自动送进新路径；`scripts/eval-selection.ts` 与 `tests/selection-input.test.ts` 的引用按本节搬法一律指 `@aihot/backend/editorial/selection-metrics`，旧路径文件不恢复。
- **本轮新开/延续的分叉登记**（下次同步按名字复查）：`industry/prompts/translate-body.md`、`translate-post.md`（ours 行业措辞 + 上游 `{{> safety}}` 片段）；`apps/web/tests/timeline-unread.test.ts`（分类值 ours 为 `regulation`）；`scripts/eval-selection.ts`（import 行 fork 路径 + 上游全符号）；`tests/selection-input.test.ts`（import 路径指 backend 模块）。**2026-10-20 更新**：`tests/selection-input.test.ts` 已被上游 `4947ad0` 删除（本站跟随删除），这条登记作废；`timeline-unread` 的分类值随上游重写搬进 `apps/web/tests/web-server.ts` 的 `feedItem()`；`scripts/eval-selection.ts` 的 fork 路径仍在（现指向 `@aihot/backend/editorial/selection-metrics`）。

---

## 2026-10-17 · 同步面清点（把这张表的路径补全）

`check-fork-changes-coverage.mjs` 在 `red49-baseline..dev` 上判出 15 个文件没在这张表里。逐条比 `upstream/main` 之后分成两半。

**第一半是真分叉面**（当前内容与上游不同）。这里面有几条本来就写在上面各节里，判据仍判「没登记」，原因是**表里只写了 `lib/url.ts`、`notify/feishu.ts` 这种相对写法**，而判据按整条路径匹配——上面那三处已经改成全路径，剩下的在这里列全：

| 文件 | 与上游不同在哪 |
|---|---|
| `site/changelog.json` | 上线公告按使用者口径重写（`bfee83f`；上游那份 14 行） |
| ~~`apps/web/app/features/admin/action.ts`~~ | **2026-10-20 起不再是分叉面**：上游 `4947ad0` 自己做了同一修复（body-less 命令不发 JSON content-type），本轮同步取上游后与上游逐字节相同；`408e275` 的行为仍由上游代码保证 |
| `packages/backend/src/editorial/translate.ts` | `timeoutMs` 读 `LLM_TIMEOUT_MS`（`a740dcc`），上游写死 `120_000` |
| `.gitattributes` | 新增：`*.sh` 与 `deploy/logrotate-aihot` 钉成 LF（这台机器 `core.autocrlf=true`，而 `deploy-direct.sh` 把工作副本原样 `tar` 上服务器） |
| `deploy/logrotate-aihot` | 新增：落实读者隐私说明里「进程日志只留 90 天」；`copytruncate` 是因为三个进程直写日志、文件描述符一直在手上。装法见 `DEPLOYMENT.md` 的「日志留多久」 |
| `apps/web/app/routes/admin/runs.tsx` | 删掉一个多余空行（与上游唯一的不同） |

**第二半不是分叉面**——它们当前与 `upstream/main` 逐字相同，出现在这个范围里是因为 2026-10-15 那次 `merge --no-ff main`（`25ea05c`）把上游提交带了进来。列在这里只为让判据读得全；同步把上游版本盖回去**不会丢任何本站东西**：

| 文件 | 说明 |
|---|---|
| `deploy/Caddyfile` | 上游 `ea96060` 加的安全响应头 |
| `packages/backend/src/admin/selectbench.ts` | 上游 `3c69b49` 的导入前校验 |
| `packages/backend/src/events/group.ts` | 上游 `791a6f5` |
| `packages/backend/src/lib/image-url.ts` | 上游 `ea96060` 拒非图片的 `data:` URI |
| `industry/prompts/summarize-short-post.md` | 上游 `ea96060` 补的 `{{> safety}}` |
| `database/migrations/0086_translation_attempt_request_tag.sql` | 上游 `540c477` 新增（编号未与本站 0083/0084/0085 撞车） |

## 2026-10-18 · 报眼日历把「安静期」画成灰点（`c7c4cfd`）

日历（报眼那个点阵）以前只分「出过刊 / 没出刊」两种点。法规台的日常恰恰是「无事发生」——出过刊、却没有东西可读——所以那一期现在用中灰点（`--ink-4`）、尺寸与黑点相同，悬停用包里的 `REPORTS.quiet.note` 说清为什么是灰的。

这一轮动到的文件里，`apps/web/app/features/report/format.ts`（`periodGrid` 多一个 `quiet` 状态、`dotMark`/`opens`）、`packages/backend/src/publication/reports.ts`（索引多算一个 `quiet`、投影里多带 `flashCount`）与 `packages/contracts/src/site.ts`（两处契约加 `quiet`）**上面各节已经登记**；只有下面这一个文件是这一轮新变成分叉面的：

| 文件 | 与上游不同在哪 |
|---|---|
| `apps/web/app/features/report/IssueDots.tsx` | 画点改成走 `format.ts` 的 `dotMark`/`opens`，安静期读 `--ink-4`（上游只有 `issue`/`current` 两态、ink/accent/idle 三色） |

## 2026-10-20 · 第二次 main→dev 上游同步（`5633b64`）

同步方式与 2026-10-15 首次相同：`git fetch upstream` → 本地 `main` ff 到 `5633b64` → `dev` 上 `git merge --no-ff main`，回滚锚点 tag `pre-sync-20261020-dev`（→ `7f0cad6`，合并前 HEAD）。范围 23 个上游提交、282 文件、+8796/−3658；**40 个冲突**（38 内容/改删 + 2 个纯改删）。过程与门禁数字见 `regdocs/阶段一验收记录.md` §64。

**本轮新变成分叉面 / 新登记的文件**（下次同步按名字复查）：

| 文件 | 与上游不同在哪 |
|---|---|
| `apps/web/tests/admin-gold.test.ts` | 新增：上游 `4947ad0` 删掉了 `apps/web/tests/admin-performance.test.ts`（连 `native-video.test.ts` 与夹具），本站把其中的 `/admin/gold` 浏览器测试搬进这个新文件；夹具与断言照旧，harness 换成上游新的 `fakeApi` |
| `packages/backend/src/editorial/eval-tools.ts` | 新增：`scripts/eval-tools.ts` 里的用例解析与指标函数（`parseCasesJsonl`/`binaryMetrics`/`round`/zod 片段）搬进后端，供 `editorial/selection-metrics.ts`（金标页与评测脚本共用）使用 |
| `scripts/eval-tools.ts` | 只改顶部一段：删掉搬走的函数定义，改成从 `@aihot/backend/editorial/eval-tools` re-export，脚本 import 面不变；其余仍是上游内容 |
| `apps/web/tests/web-server.ts` | `feedItem()` 默认分类改成 `regulation`（上游重写 `timeline-unread.test.ts` 时把本站那处替换的内联夹具搬进了这个共享夹具） |
| `packages/backend/src/editorial/selection-metrics.ts` | 跟随上游重写（`SelectionThresholdCase` 变成 `{gold, available, passed, scores}`、`selectionGoldPool` 删除），顶部保留本站三行用途注释；`admin/gold.ts` 的扫描按新 API 传 `scores`/`passed`（存的是均分，用两次相同分值复现原来的 `mean >= 门槛` 判定） |

**上一轮登记、本轮因上游变化而更新或失效的**：

| 项 | 变化 |
|---|---|
| `apps/web/app/features/admin/action.ts`（body-less DELETE 不发 JSON content-type） | 上游 `4947ad0` 自己做了同一修复；本轮取上游后与上游逐字节相同 ⇒ 不再是分叉面（上面 2026-10-17 表里那条已划掉） |
| `tests/selection-input.test.ts` / `tests/selection-eval-metrics.test.ts` 的 import 路径 | 上游 `4947ad0` 删除了这两个测试（被测 API 已重写/删除），本站跟随删除 ⇒ 原登记作废 |
| `apps/web/tests/timeline-unread.test.ts` 的分类值 | 上游重写该文件，本站那处 `regulation` 替换随内联夹具搬进 `apps/web/tests/web-server.ts`（见上表） |
| `apps/web/tests/native-video.test.ts` | 上游删除（连夹具）；本站只改过分类字面量 ⇒ 接受删除。**web 套件基线更新**：原「59 条 / 58 绿 / 1 红（WebKit native video）」作废，本轮之后是 73 条；默认并发在本机偶发 3 条启动超时/WebKit 抖动，`--test-concurrency=2` 复跑 73/73 全绿 |
| `industry/prompts/{content-understanding,group-batch,group-method,rules-self-contained-title}.md` | 上游新增的措辞按本站行业改写后并入（旧发布/本条动作的区分、精确发布时间）；`content-understanding.md` 上游新增句依赖 AI 行业的内容类型词表，本站 9 类里没有对应项 ⇒ 不采用 |
| `industry/taxonomy.ts` | 补上游新字段：分类 `tagColor`（飞书卡片小标签颜色，框架读它）、`ENTITIES` 类型 `orgNames?`；本站分类与机构名录不变 |
| `site/site.ts` | 补上游新字段 `psb`（公安备案）与 `organization.founder: Founder \| null`（用上游 `@aihot/contracts/site-config` 的类型） |
| `packages/backend/src/lib/url.ts`、`lib/http-fetch.ts`、`config.ts`、`.env.example` | 上游新加的 `PRIVATE_FEED_HOSTS`（信源订阅内网放行）与本站 `INTERNAL_EGRESS_ALLOW`（P2）并存：两套白名单各自独立；`http-fetch.ts` 里 internal 分支与上游 privateHost 分支并存 |
| `packages/backend/src/providers/llm.ts` | 上游重写（failover + 熔断）；本站 P3 并发闸门 `enterModel()/leaveModel()` 与 `LLM_TIMEOUT_MS` 默认超时重新落在新结构上 |
| `packages/backend/src/content/extract.ts` | 上游新增「`UnavailablePageError` 当没有正文」分支；本站「预算拒绝要抛给 worker」保留（只吞 unavailable，不吞 `BudgetExceededError`） |
| `packages/backend/src/reports/compose.ts` | 上游加了「完整安静期跳过不出刊」；本站保留「安静期照出刊（`REPORTS.quiet`）」的既定语义（Item 27），只取上游的 `entityNames` 与 `composeDueReports` 的中断/空返回值处理 |
| `packages/backend/src/modules.ts` | 上游删掉 `Responder`/`checkArgs`/`sitemap.pages`；本站的 `ReportBlock`/`reportBlocks`/`moduleReportBlocks` 保留 |
| `database/migrations/0086_feedback_ban_expiry.sql` 等 | 上游新增 0086/0087/0088/0089 四个迁移；编号与本站 0083/0084/0085 及既有的 `0086_translation_attempt_request_tag.sql` 不冲突（按完整文件名排序执行） |

### 同步面补登记（`check-fork-changes-coverage.mjs` 从红到绿）

2026-10-17 那次清点只补了当时扫出来的 15 个。这次同步完用 `5633b64..HEAD`（= 本站相对上游 tip 的全部差异，比 `red49-baseline..HEAD` 更准）重扫，又判出 50 个没在表里的文件；其中绝大多数是**本站相对上游一直有的差异，只是之前没按全路径登记**。两类都补在这里：

**上游也有、本站改过的**（下次同步会被上游版本盖掉，必须登记）：

| 文件 | 与上游不同在哪 |
|---|---|
| `apps/web/app/app.css` | 本站自定义主题：暖纸/墨色、衬线正文 + 无衬线标题、明暗两套 token（Mimo 选项已下线，见 2026-10-22 节） |
| `apps/web/app/root.tsx` | `theme-color` 两枚 meta 换成本站纸色/夜色的 `#f8f4ea` / `#0f0f0c`；head 的 `links` 加 PT Serif/Ubuntu 的 Google Fonts link 与 preconnect |
| `packages/backend/src/media/og.ts` | 分享图配色换成暖纸/琥珀主题；模板版本 `og-2026-10-22.1` |
| `packages/backend/src/media/poster.ts` | 海报配色换成暖纸/赭红主题；模板版本 `poster-2026-10-22.1` |
| `apps/web/app/routes/admin/settings.tsx` | 未接线的投递用途（`alert`/`feedback`）禁用「启用」并标「未接线」（Item 24 的前端一半） |
| `packages/backend/src/admin/settings.ts` | 同上的后端一半：`purpose !== "content"` 的投递目标不可启用（审计之前就挡） |
| `industry/selection.ts` | 法规台的门槛与加权（T1 55 / T1_5 62 / T2 74、`understandFloor` 48、BR-22 的 `AUTHORITATIVE_TIERS`） |
| `industry/prompts/{group-pair,prefilter,rules-domain,selection-score,structure}.md` | 行业措辞（AI 行业示例换成车载法规；与 1.3 那批同源，之前只登记了其中一部分） |
| `packages/backend/src/editorial/analyze.ts` | `DEFAULT_LLM_TIMEOUT` 读 `LLM_TIMEOUT_MS`（上游写死 `120_000`） |
| `packages/backend/src/events/hot.ts` | BR-22「T1 出现即采信」：热度判定改走 `publication/corroboration.ts` 的 `isCorroborated`，多查一个 `authoritative` |
| `packages/backend/src/publication/agent.ts` | 读者链接字段 `links.aihot` → `links.portal`（去 AIHOT 品牌） |
| `packages/backend/src/publication/stories.ts` | 同上，事件页链接 |
| `packages/backend/src/publication/v1.ts` | 同上，v1 契约的 `links.aihot` → `links.portal` |
| `packages/contracts/src/admin.ts` | 金标后台的契约（`/api/admin/gold`、selectbench、反馈处置，72 行） |
| `site/brand/{logo.svg,icon.png,icon-192.png,apple-icon.png,favicon.ico}` | 本站品牌资产（上游是 AIHOT 的） |
| `package-lock.json` | 本站加过的依赖锁（同步后按 `package.json` 重生成；`entities` 是上游新增的） |

**本站新增、上游没有的**（同步碰不到，列全只是让判据读得全）：

| 文件 | 说明 |
|---|---|
| `modules/columns/{module.ts,package.json,web.tsx,web/ncap.tsx,web/oem.tsx,web/regulations.tsx,web/standards.tsx}` | 栏目模块（本站自己的栏目页） |
| `modules/regulation/{package.json,server.ts,migrations/0084_regulation_schedule.sql,tests/countdown.test.ts}` | 法规模块（倒计时等） |
| `site/modules/{index.ts,server.ts,web.ts}`、`site/package.json` | 站点侧模块装配与包声明 |
| `start.sh` | 本机/服务器启动脚本（与 `deploy/` 同源） |
| `scripts/{backfill-regulations.ts,bootstrap-server.sh,deploy.sh,regulations-backfill.json,status.sh,sync.sh,tunnel-web.sh}` | 本站运维与数据脚本（上游没有） |
| `database/migrations/0085_gold_labels.sql` | 金标表迁移（上游没有，编号不与上游撞） |
| `packages/backend/src/publication/corroboration.ts` | BR-22「T1 出现即采信」的共用判定（上游没有） |
| `我的开发笔记本.md` | 使用者的开发笔记（不进 PR，但同步不能盖） |

判据重扫的跑法：范围 `5633b64..HEAD`，并用 `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.renames GIT_CONFIG_VALUE_0=false` 关掉 rename 检测——否则 `466ceb5` 那次改名（`scripts/eval-selection-core.ts` → `packages/backend/src/editorial/selection-metrics.ts`）会拼出一条带 tab 的路径，判据认不出；关掉后旧路径按「已删」排除、新路径已登记。本轮重扫结果：**0 个未登记，SYNC SURFACE COVERED**。

顺带清掉一处死代码：`packages/contracts/src/index.ts` 只有一行 `hello` 占位导出、全仓无引用（上游根本没有这个文件），本轮删除，少一个分叉面。

### 部署前服务器车道复跑（2026-10-20）

根套件（连库）在服务器车道的干净树 `/opt/aihot-lane` 上跑（= 本地 HEAD 的 `git archive`，不碰生产树）：

- **第一次全量**：997 条 / 965 绿 / **32 红**。逐条分三类：① **车道形态 3 条**（树里没有 `.git`：architecture 的「every environment variable…」「Beijing time…」、outbound 的「no code turns certificate verification off」）；② **车道没构建 web 14 条**（`malformed-public-paths`/`page-metadata` 起 `apps/web/build/server/index.js`）；③ **真差异 13 条**，修法见下。
- **真差异与修法**：
  - `apps/web/app/routes/admin/gold.tsx` 用了 `rounded`/`rounded-lg`——上游这一轮新增的 architecture 判据要求半径刻度，改成 `rounded-tile`/`rounded-mark`/`rounded-card`。
  - `tests/selected-card.test.ts`（上游新增）拿示例行业分类与 OpenAI/ChatGPT 夹具写断言：`ai-products`→`vehicle`、`ai-models`→`technology`、`paper`→`standard`，夹具换成比亚迪/汉 EV（Item 34/38 的换法）。
  - `tests/report-recovery.test.ts`（上游新增）按「安静期不出刊、缺一天日报算失败」写：本站**不收**「缺一天日报算失败」（旧缺口会每跑必败，§63 定过），自动跑仍按安静期补；**收**上游两条保护——日报条目全被撤、显式重出会把「本来有内容」的期重写成安静，都拒绝。对应用例按本站语义改写。
  - `tests/news-value.test.ts` 一个文件里密集归组二十来篇，召回向量调用把 dashscope 每分钟 100 次的默认额度打满：与其它付费用例的文件一致，在 `before` 里放宽本文件的窗口（生产调用分散在几十分钟里，不受影响）。
- **第二轮全量**（修完 + 车道构建 web）：997 / 993 绿 / 4 红——3 条车道形态 + 1 条回归（`tests/report-issues.test.ts` 的「安静期重出留 revision」，被上面「显式重出一律拒绝」误伤）。
- **收紧判据后第三轮全量**：**997 条 / 994 绿 / 3 红**，红的正是那三条车道形态（无 `.git`）。**结论：没有产品回归，可以上线。**

**本轮新增/改写的测试分叉面**（下次同步按名字复查）：`tests/selected-card.test.ts`（分类与夹具换本站）、`tests/report-recovery.test.ts`（安静期判据按本站语义）、`tests/news-value.test.ts`（dashscope 窗口）、`apps/web/app/routes/admin/gold.tsx`（半径刻度类）、`packages/backend/src/reports/compose.ts`（见上）。

### 飞书登录与个人订阅推送（2026-10-21）

本站新增读者订阅模块，读者用飞书登录后把日报/周报/月报收到个人单聊。改动面：

**上游也有、本站改过的**（下次同步会被上游版本盖掉，必须登记）：

| 文件 | 与上游不同在哪 |
|---|---|
| `packages/backend/src/config.ts` | 新增 `feishuReaderPushEnabled`（`FEISHU_READER_PUSH_ENABLED`，默认 false） |
| `packages/backend/src/notify/feishu.ts` | 新增 `sendDirectMessage()`：单聊卡片、超时/业务错误分类；文件头注释补读者推送 |
| `packages/backend/src/publication/facets.ts` | 新增文件（上游没有）：`itemFacets()`，按条目取分类/标签/主题/可用性 |
| `packages/contracts/src/subscriptions.ts` | 新增文件：读者订阅的前后端契约 |
| `apps/web/app/lib/local-state.ts` | 收藏条目多 `category`/`tags`（旧数据补空） |
| `apps/web/app/features/feed/parts.tsx`、`apps/web/app/features/item/ReaderTools.tsx` | 收藏时带上分类/标签 |
| `tests/setup.ts` | 测试里 `FEISHU_READER_PUSH_ENABLED=false` |
| `scripts/smoke.ts` | 冒烟加 `/subscriptions` 与 `/api/subscriptions/options` |
| `.env.example` | 新增读者推送开关与 `FEISHU_API_BASE` 注释 |
| `Dockerfile` | `npm ci` 前 COPY 新模块的 `package.json` |
| `site/site.ts`、`site/pages/privacy.md`、`site/changelog.json`、`docs/deploy.md` | 读者文案、隐私说明、更新日志与部署说明 |

**本站新增、上游没有的**：

| 文件 | 说明 |
|---|---|
| `modules/subscriptions/{auth.ts,card.ts,data.ts,module.ts,package.json,server.ts,web.tsx}`、`modules/subscriptions/migrations/*.sql`、`modules/subscriptions/tests/*.test.ts`、`modules/subscriptions/web/subscriptions.tsx` | 读者登录、订阅管理、推送扫描/队列/卡片、4 个迁移与测试（嵌套路径分行登记：`check-fork-changes-coverage.mjs` 的 `*` 不跨目录，`**` 只按单层解释） |
| `apps/web/tests/subscriptions.test.ts` | 订阅页 SSR 测试（登录前/登录后、私密缓存头） |
| `site/modules/{index.ts,server.ts,web.ts}`、`site/package.json` | 注册新模块与包声明 |
| `regdocs/06-飞书订阅推送.md` | 本功能的方案与上线记录 |

### 主题换新：暖纸 + 墨色，明/暗/系统三档（2026-10-22）

把原来“基础主题 + 第 4 个 Mimo 选项”改成一套本站主题。设计决定：**Mimo 的排版关系**（正文衬线、标题无衬线、基础结构）+ **卷宗公报版的暖纸配色**；没有搬公报版的 A 结构（双线日期条、左侧索引条、方形 kicker、收紧圆角、去卡片悬浮）。浅色 `#F8F4EA` / `#211A12` / `#7A3E2E`，深色 `#0F0F0C` / `#EDE7DC` / `#D9A15F`；深色阴影全关。

**主题开关**只剩深色／跟随系统／浅色三档，入口不变（侧栏和「我的」页）。`ThemeSwitch.tsx` 和 `icons.tsx` 已恢复成上游版本，不再算分叉面；`local-state.ts` 的主题段恢复上游实现（含 `matchMedia` 监听、`followsSystem` 参数），只把 `THEME_COLOR` 换成新色；旧 `aihot-theme=mimo` 按跟随系统处理。Mimo 的 Google Fonts 加载、`loadMimoFonts`/`unloadMimoFonts`、Mimo token 和字体规则全部删除。

**排版**：字体与 Mimo 主题完全一致——Mimo 的 wildcard 规则把 `body` 和除 `code`/`pre`/`.num`/`.font-mono`/`svg` 外的元素设为 `"PT Serif", Georgia, "Times New Roman", "Noto Serif SC", serif`，标题规则用 Ubuntu；`--font-sans` 也换回 Mimo 的 `"Ubuntu", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`。这条标题规则和 Mimo 原版一样被 wildcard 的特异性盖住，实际渲染仍是 PT Serif；保留是为了和 Mimo 完全一致。PT Serif/Ubuntu 由 `root.tsx` 的 Google Fonts link 加载（Mimo 原来的做法），隐私说明保留 Google Fonts 例外，版本 1.2。`[data-font="browser"]` 仍优先（用更高特异性的 wildcard 覆盖）。

**分享图/海报**：`OG_TEMPLATE_VERSION` → `og-2026-10-22.1`，`POSTER_TEMPLATE_VERSION` → `poster-2026-10-22.1`；OG 深色卡换 `#0F0F0C`/`#EDE7DC`/`#D9A15F`，海报浅色换 `#F8F4EA`/`#211A12`/`#7A3E2E`。生成图仍用 Noto Sans SC。

**改动文件**（上游也有、本站改过的）：`apps/web/app/app.css`、`apps/web/app/root.tsx`、`apps/web/app/lib/local-state.ts`（只剩收藏 `category`/`tags` 差异）、`packages/backend/src/media/og.ts`、`packages/backend/src/media/poster.ts`；本站文件：`site/pages/privacy.md`、`site/changelog.json`、`site/public/manifest.webmanifest`、`docs/deploy.md`。

**验证**：`tsc -p apps/web`（沙箱里 `react-router typegen` 因 spawn EPERM 跑不了，用已生成的 `.react-router/types` 直接过）、`node --test apps/web/tests/local-state.test.ts`、`node --import ./tests/standalone.ts --test tests/local-font.standalone.test.ts`；本地构建预览检查明/暗/系统和三档开关。设计对照原型留在 `.data/theme-preview/`（gitignored，不提交）。

**同步提醒**：下次上游同步会覆盖 `app.css` 的 token/字体规则、`root.tsx` 的 theme-color 与 Google Fonts link、`local-state.ts` 的主题段（如果上游也改了），以及 `og.ts`/`poster.ts` 的配色；按本节恢复。`site/` 下几份按上游约定以本地为准。

## 2026-10-22 · 第三次 main→dev 上游同步（`b3998dc`）

同步方式与前两次相同：`git fetch upstream`（本机 schannel 仍报 `SEC_E_NO_CREDENTIALS`，用 `git -c http.sslBackend=openssl fetch`）→ 本地 `main` ff 到 `b3998dc` → `dev` 上 `git merge --no-ff main`，回滚锚点 tag `pre-sync-20261022-dev`（→ `19b9540`，合并前 HEAD，含当天先把订阅推送与主题换新落成的 checkpoint）。范围 **14 个上游提交、14 文件、+204/−80；0 冲突**（合并提交 `2d8e515`）。

**本轮内容**：

- 我们提的两个后台修复被上游合并：`9aa1cb6`（退出登录的表单 POST 不再 415）与 `f351014`（已登录时登录页和 `/api/auth/login` 直接跳到目标页）；上游另补两条测试：`cdd61cc`（退出登录前的表单解析保留大小上限，超限 413 且不动会话）、`09d9f25`（已登录跳转的 `return` 只能指向本站后台）。同步前本地未提交的同名改动已还原、改从上游取——两边源码一致，测试以上游合并版为准（维护者的两条断言一并收下）。
- 依赖安全修复：`fastify` 5.12.5→5.12.7、`undici` 8.11.2→8.12.3、`sanitize-html` 2.17.7→2.18.1、`vite` 8.3.3、`@modelcontextprotocol/{client,server}` 2.3.0；根 `package.json` 的 engines 提到 `node >=24.22.1`（本机 v24.14.1 只报 EBADENGINE 警告，类型检查与测试不受影响）。合并后 `npm install` 通过，`npm install --package-lock-only` 无差异（锁文件与四个 `package.json` 一致）。
- 正文抽取：上游新增「登录/注册页不能变成文章」两层判据（列表选择器与重定向，`690456b`/`a0d1e75`）；本站「预算拒绝要抛给 worker」的既有规则保留（自动合并：`content/extract.ts` 里照旧只吞 `UnavailablePageError`，`BudgetExceededError` 继续抛给 worker）。
- 文档：`docs/sources.md` 写明 `detail.maxFetches` 不设时为 0（一篇详情页都不读）。

**本轮没有新的分叉面**：上游改的 14 个文件里，`admin-auth.ts`/`admin.server.ts`/`admin-login.tsx`/`tests/private-routes.test.ts`/`apps/web/tests/cache.test.ts` 由上游合并版取代（同步前本地同名改动已还原，不再算分叉面）；其余文件本站没有本地修改。上一节「同步提醒」列的主题相关文件（`app.css`、`root.tsx`、`local-state.ts`、`og.ts`、`poster.ts`）上游本轮没动，不需要恢复。

**门禁**（2026-10-22）：

- `npm run typecheck`：八段全绿。
- `npm run build -w @aihot/web`：过，server bundle 795.07 kB。
- 本地 `node --test --test-concurrency=2 "apps/web/tests/*.test.ts"`：**78 / 78 全绿**（上轮基线 73 条；多出来的是订阅页 SSR 测试与新合并的登录跳转测试）。
- 服务器车道 `/opt/aihot-lane`（= 本地 HEAD `2712681` 的 `git archive`，连 `aihot_lane2_ci`）：根套件 **1017 条 / 1014 绿 / 3 红**，红的正是已知的三条车道形态（树里没有 `.git`：architecture 的「every environment variable…」「Beijing time…」与 outbound 的「no code turns certificate verification off」）；standalone **231 / 230 / 1 红**，同一形态。车道顺带查出一条真问题并已修：订阅页三处 `rounded-xl` 改成本站刻度 `rounded-card`（`2712681`），architecture 的圆角判据转绿。

**回滚**：`git reset --hard pre-sync-20261022-dev`（`19b9540`）；若要连订阅推送/主题换新一起退，再退到 `026fb88`（第二次同步后的 HEAD）。

**部署与上线验证（2026-10-22 20:04，使用者：「好的，上线吧」）**：部署前 `pg_dump` 到 `/root/aihot-pre-deploy-20261022.dump`（18 MB；`schema_migrations` 72 条、26 信源、521 篇）。`bash scripts/deploy-direct.sh 172.17.13.184 18177` exit 0：`npm install` 0 vulnerabilities → web build **795.07 kB** → 迁移 `database is up to date`（订阅推送的四条迁移早前已应用，本轮无新增）→ seed `0 added, 25 already there` → `start.sh` 三个进程 `NODE_ENV=production`（pid 348287/348288/348289）。上线后验证：`/api/health` ok；`node scripts/smoke.ts` → `all checks passed`；21 个页面全 200（含 `/subscriptions`）；后台回归——密码登录 303→`/admin`、已登录 GET `/api/auth/login?return=/admin/content` 302→`/admin/content`、`return=javascript:` 收敛到 `/admin`、已登录 `/admin/login?return=…` 302→目标页、纯表单 POST `/api/auth/logout` 303→`/` 且清 `aihot_admin`、匿名 GET `/api/auth/login` 302→登录页；`/api/auth/options` 仍 `{"password":true,"feishu":true}`；`job_runs` 重启后五类任务全 `ok`（含 `subscriptions.deliver`）；`logs/{api,worker,web}.log` 0 error/fatal/unhandled；依赖版本 `fastify` 5.12.7 / `sanitize-html` 2.18.1 / `undici` 8.12.3（backend 内嵌；根 `node_modules` 的 7.30.0 是别的依赖的）。本次部署也把同步前 checkpoint 里的订阅推送与主题换新一并带上线（首页 theme-color `#f8f4ea`/`#0f0f0c`、`/subscriptions` 与更新日志两条新记录都在线上）。回滚：代码 `git reset --hard pre-sync-20261022-dev` 后重走部署；库用 `/root/aihot-pre-deploy-20261022.dump` 恢复。

**未推送 origin**：`dev` 只在本机；`origin/main` 仍是 `5633b64`。下一步等使用者定：是否把 `dev` 推到 `origin`。

## 2026-10-28 · 第四次 main→dev 上游同步（`79d962e`）

同步方式与前三次相同：`git fetch upstream`（本机 schannel 仍报 `SEC_E_NO_CREDENTIALS`，用 `git -c http.sslBackend=openssl fetch`）→ 本地 `main` ff 到 `79d962e` → `dev` 上 `git merge --no-ff main`，回滚锚点 tag `pre-sync-20261028-dev`（→ `5bb8399`，合并前 HEAD，含当天先把开发笔记本改动落成的那笔 docs）。范围 **7 个上游提交、17 文件、+321/−28**；**1 个冲突**（合并提交 `fa84dd1`，消息 `merge: 同步上游 79d962e（7 提交 / 17 文件 / 1 冲突）`）。

**本轮内容**：

- 相对日期：`packages/backend/src/sources/dates.ts` 新增 `readRelativeDate()`——列表页的日期元素印「今天 15:46」「昨天」「前天」「20小时前」「2天前」「3 hours ago」「16h ago」时按读取时刻倒推；「47小时前」保留时刻，只有「天」才截到日历日；带署名前缀的（「作者·48分钟前」）也认。`web-list.ts` 的 `elementDate()` 在常规日期读不出时回退到它。
- 登录页识别：`content/extract.ts` 的 `AUTH_PATH` 补 Devise 的 `/users/sign_in`、WordPress 的 `/wp-login.php`、带扩展名的 `/login.php` 等；本站「预算拒绝要抛给 worker」的既有规则保留（自动合并，只吞 `UnavailablePageError`）。
- 跨年日期（web）：日报切换 chip、前后日期链接、跟进徽章、事件页与主题页的日期戳，改走 `app/lib/format.ts` 新导出的 `monthDay(date, now)`——按北京时间判年，别的年份带「2026年」。
- 告警可发群机器人：`feishu.ts` 支持 `FEISHU_ALERT_WEBHOOK_URL`，填了就走自定义机器人 webhook（纯文本，按 20 KB/请求、100 请求/分钟切分），不再用消息应用与群 ID；本站读者推送的 `sendDirectMessage()`/`API`/`tenantToken` 与上游新代码并存。
- 测试：新增 `tests/sign-in-paths.standalone.test.ts`、`apps/web/tests/report-year.test.ts`；`tests/source-dates.standalone.test.ts`、`apps/web/tests/day-header-year.test.ts`、`tests/watchdog.test.ts` 扩充（watchdog 加两条 webhook 用例）。

**冲突只有一处**：`packages/backend/src/notify/feishu.ts` 的文件头注释（两边各改了一版）——取并集：本站的「reader sign-in / readers' report cards in their single chats」+ 上游的「alerts 可走 webhook、feedback 截图仍要应用」。其余四个两边都改过的文件自动合并、语义都在：`.env.example`（上游 `FEISHU_ALERT_WEBHOOK_URL` + 本站 `FEISHU_READER_PUSH_ENABLED`/`FEISHU_API_BASE`/`FEISHU_BITABLE_*`/`INTERNAL_EGRESS_ALLOW` 等）、`apps/web/app/features/report/ReportPaper.tsx`（本站 `blocks`/`silence` 版块 + 上游本地 `monthDay` 导入）、`apps/web/app/features/report/format.ts`（本站 `quiet` 点/`dotMark`/`opens` + 上游跨年 chip/neighbour 标签）、`packages/backend/src/content/extract.ts`（本站预算规则 + 上游 `AUTH_PATH`）。

**本轮没有新的分叉面**。判据重扫补了两处登记：`apps/web/app/features/item/ReaderTools.tsx` 原来只写了相对路径；`modules/subscriptions/` 的嵌套文件（4 个迁移、4 个模块测试、`web/subscriptions.tsx`）原来靠 `modules/subscriptions/**` 兜底，而 `check-fork-changes-coverage.mjs` 的 `*` 不跨目录、`**` 只按单层解释——现在按目录 glob 分行登记。按 §64 的跑法（`GIT_CONFIG_*` 关掉 rename 检测）重扫 `upstream/main..HEAD`：**153 个会被同步覆盖的文件、0 个未登记，SYNC SURFACE COVERED**。

**门禁**（2026-10-28）：

- `npm run typecheck`：八段全绿（受限沙箱里 web 的 `react-router typegen` 要放开才跑得动——vite 加载配置时 spawn 子进程 EPERM，与代码无关）。
- `npm run build -w @aihot/web`：过，server bundle **795.50 kB**。
- 本地 `node --test --test-concurrency=2 "apps/web/tests/*.test.ts"`：**82 / 82 全绿**（§66 基线 78 条 + 上游新增的 4 条跨年用例）。
- 本地 `npm run test:standalone`：**236 条 / 233 绿 / 3 红**——红的是 `outbound direct|proxy keeps larger response headers confined to one host` 那对与 `outbound-protocol` 的同一条 Windows libuv 断言（`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76`）；这两个文件本次合并没动过（`git diff 5bb8399..HEAD --` 为空），是 §48/§56/§64 记过的本机环境项。
- 根套件（连库）**未跑**：本机没有 Postgres、Docker daemon 没起（`docker ps` 连不上 `npipe:////./pipe/dockerDesktopLinuxEngine`），按 §64 先例待服务器车道复跑补。

**回滚**：`git reset --hard pre-sync-20261028-dev`（`5bb8399`）。

**未部署、未推送 origin**：`dev` 只在本机（`origin/main` = `upstream/main` = `79d962e`）。下一步等使用者定：是否跑服务器车道、是否部署上线、是否把 `dev` 推到 `origin`。

## 2026-11-02 · 第五次 main→dev 上游同步（`38d130f`）

同步方式与前四次相同：`git -c http.sslBackend=openssl fetch upstream`（本机 schannel 仍报 `SEC_E_NO_CREDENTIALS`）→ 本地 `main` ff 到 `38d130f` → `dev` 上 `git merge --no-ff main`，回滚锚点 tag `pre-sync-20261102-dev`（→ `aa982c2`，合并前 HEAD）。范围 **37 个上游提交、210 文件、+4013/−1646；15 个冲突**（合并提交 `c4fd49f`，消息 `merge: 同步上游 38d130f（37 提交 / 210 文件 / 15 冲突）`；合并后 `git diff --stat` 210 文件 +4037/−1656）。

**本轮内容**：

- 信源类别门槛：`industry/selection.ts` 新增 `classes`（每个类别一个门槛下限）与 `browseFloor`（浏览「全部动态」的最低分）。后台「信源」页可给官方信源选一个类别，入选门槛抬到不低于类别的数，只抬不降；`tierThreshold(tier)` 换成 `selectionThreshold({ tier, selectionClass })`（`packages/backend/src/editorial/analyze.ts:61-65`），调用点全部跟着改。`sources` 表加 `selection_class` 列（迁移 `0090_source_selection_class.sql`）；`browseFloor` 由 `publication/scope.ts` 的 `browsedCondition` 落实，网页列表、`/api/v1/items`、`/api/v1/agent/latest` 的 `mode=all`、MCP 的 `all`、「全部动态」RSS 都只出不低于它的资料，带搜索词时仍搜全部。
- 告警先交自动处理服务：`WEBHOOK_HUB_URL` / `WEBHOOK_HUB_KEY`（`packages/backend/src/notify/agent.ts`、`feishu.ts` 的 `toldThroughHub`）。配好后「读者受影响」「今天要处理」两级先交出去，1 小时 / 3 小时没恢复或一天里第三次才发给本人；只有本人能处理的照常立刻发；09:00 系统日报被收下就不再发。发本人的消息也先走它的 `/tell`。`AGENT_WEBHOOK_URL` / `AGENT_WEBHOOK_KEY` 不再读取，请求格式也换了。另新增「大量信源抓取失败」告警（失败信源 ≥50 个且占最近抓取过的 ≥15%），群机器人改成一次一条、隔 600 毫秒。
- 分享图回退字体：`assets/og-fonts/` 下放 `<名字>-400.ttf` / `-700.ttf`，satori 在 Noto Sans SC 缺字时按文件名顺序取；字体名进 `ogEtag`，海报与分享图共用同一套（`media/og.ts`、`media/poster.ts`）。
- 政府站点 TLS 握手被拒时用 P-256 曲线重试一次：`lib/http-fetch.ts` 的 `pinnedCurveAgent()` / `brokenHandshake()`，只对 GET/HEAD、只对直连，`ALLOW_PRIVATE_NETWORK_FETCH` 打开时不重试。
- 后台 cookie 的 `Secure` 按请求协议判断（`apps/api/src/routes/admin-auth.ts`），Nginx 反代要补 `proxy_set_header X-Forwarded-Proto $scheme;`（`docs/deploy.md` 已写明，少了它明文入口会丢登录 cookie）。
- 站点地图拆成 `/sitemaps/<section>.xml`（含 `topics.xml`），索引仍是 `/sitemap.xml`（`publication/sitemap.ts`、`apps/api/src/routes/static.ts:123`）。
- 正文翻译的规则拆成共享片段：`industry/prompts/translate-body-rules.md` + `translate-body-retry.md`，`translate-body.md` 用 `{{> translate-body-rules}}` 引用，不再逐条重抄。
- 反馈分类与建议池：`feedback` 表加 `kind`（BUG/建议/提问/其他）与 `idea`（归入的建议名）两列（迁移 `0091_feedback_kind.sql`、`0092_feedback_idea.sql`），后台可标类型、把建议归到同一个名字下，按提出人数排序。
- 信源「用途」：模块可以声明自己的信源用途（`ServerModule.sourceUses`），一个信源可被多个用途共用、抓取节奏取最快的那个（`packages/backend/src/sources/uses.ts`、迁移 `0105_source_uses.sql`）。
- 模块的全文翻译导入带版本校验（`editorial/translate.ts`，`823db74`）。
- 图片先给 AVIF：`apps/web/app/components/ui/Picture.tsx` 用 `<source type="image/avif">` 包住原来的 `img`，AVIF 变体由 worker 按需生成，`media/similarity.ts` 用 SSIM 把变体与原件比，小一成以上才留。
- 备份：每个文件只传一次、放 `monthly/` / `weekly/` / `daily/` 前缀下，没有附件时只传 `.dump`。
- 模型服务拒绝调用后的暂停：拒绝之前已发出的请求后来成功了不再解除暂停；拒绝时不再顺手删别的模型一天前过期的暂停记录（两个模型同时被拒会互相等行锁、死锁后丢掉拒绝）。
- 依赖：zod 4.6.6（校验超大带约束集合时可能耗尽内存）、undici 7.30.1、fast-uri。`package.json` 新增 `"test:web"`，`AGENTS.md`、`docs/architecture.md`、`.github/workflows/check.yml` 的检查命令都改成 `npm run build -w @aihot/web && npm run test:web`。
- 文档：`docs/customize.md` 的 §1/§2 不再重抄字段注释、改成「看文件内注释 + 这几处联动」；`docs/deploy.md` 补 2026-10-31 引擎同步的更新说明（三个迁移、`classes`/`browseFloor`、告警、暂停语义、图片、备份、反馈后台）与「怎么省模型费用」；`docs/sources.md` 补信源类别；README 写明可安装的 Agent Skill 只留在 AIHOT 线上。
- 测试：新增 `tests/owner-alerts.test.ts`、`tests/source-uses.test.ts`；上游把三个文件并进已有文件后删除——`apps/web/tests/day-header-year.test.ts`、`apps/web/tests/report-year.test.ts` 的断言并入 `apps/web/tests/report-ordinals.test.ts` 与 `tests/timeline-day-counts.test.ts`，`tests/sign-in-paths.standalone.test.ts` 整份删除（`isSignInUrl`/`isSignInRedirect` 的断言不再保留）。

**15 个冲突逐项处置**：

- `industry/selection.ts`：整体按本站重写。保留 `thresholds { T1: 55, T1_5: 62, T2: 74 }`、`understandFloor: 48`、`corroboration`、`regulationCategories`、`regulationWeight: 1.6`；新增 `classes: {}`（本站不用这个功能，注释里写了示例站配 ecosystem 70 / leaderboard 76）与 `browseFloor: 0`（法规原文与附表的分数天然偏低，示例站的 40 会把必须跟的东西挡掉）。
- `site/site.ts`：`ALERTS` 补上游新字段 `quietWhileFetchingMinutes: 720`（本站注释风格）；`FEED_COPY.allLeavesOut` 的注释取本站原文——本站 `browseFloor` 是 0，`publication/feeds.ts` 的 `LEFT_OUT` 里不再有「低分条目」那一条，注释也就不能跟着上游那么写。
- `packages/backend/src/lib/http-fetch.ts`：两处都保留。本站的内部放行通道（`internalAgent`、`internalTarget()`、`dispatcherFor(viaProxy, privateHost, internal)` 三参）与上游的 `pinnedCurve` 重试并存；send 循环先算 `viaProxy` / `privateHost` / `internal`，`send(direct)` 失败后再判 `pinned = viaProxy || privateHost || internal || signal.aborted || !brokenHandshake(error) ? undefined : pinnedCurveAgent()`——内部放行通道在重试路径上不丢。
- `packages/backend/src/notify/feishu.ts`：文件头注释取并集（本站的 admin OAuth / reader sign-in / readers' report cards + 上游「What the owner is told (sendAlert) goes first to Agent 自动化中台, which passes it on.」）。上游的 `Finding.owner` / `agentOnly` / `agentType`、`formatReturn`、`toldThroughHub`、`webhookTurn` 已并入；本站导出的 `API` 与 `tenantToken` 保留。
- `industry/prompts/translate-body.md`：本站译者身份行「你是熟悉汽车与法规领域的专业译者」+ 上游新增的风格要求（改成「像中文汽车与法规媒体直接用中文写的稿子」）+ `{{> translate-body-rules}}`，原来那 6 条具体规则删掉（片段里已经有了）。
- `industry/prompts/translate-body-rules.md`（上游新增，本站取其副本再改）：第 1 条改成「行业术语用中文通行译法（法规文号、标准号保留原文写法，全篇前后一致）」；第 6 条把可保留英文原名的类别从「公司、产品、模型与人名」改成「机构名、标准号与法规文号、车型与芯片名、人名」。
- `industry/prompts/translate-body-retry.md`（上游新增）：身份行换成本站车载译者，其余（`{{> safety}}`、`{{> translate-body-rules}}`、丢链接重试）与上游一致。
- `docs/selection.md`：本站门槛数字与校准口径为准，补 `classes`（按本站为空写，说明它怎么工作、键不要改名）与 `browseFloor`（按本站 0 写，说明它管哪几个出口、搜索不受限）两段机制说明。
- `docs/customize.md`：三处冲突按「取上游新结构 + 保留本站专属说明」重排。§1 用上游的六条要点 + 本站第 7 条「安静的一期怎么说」（`REPORTS.quiet` 按报别三支）；§2 用上游的四条 + 本站车载标签规则（哪些材料不许归进「法律法规」「行业标准」）；§5 用本站门槛数字（T1 55、T1_5 62、T2 74）与「起点、要在标注样本上校准」的口径，并补 `classes` 空、`browseFloor` 0 的说明。
- `industry/taxonomy.ts`、`industry/topics.json`：取本地（上游改动只是示例行业的实体改名 kimi →「月之暗面 / Kimi」与 lexicon 同步，没有结构变化）。
- `package.json`：`test:standalone` 取上游的 `"modules/*/tests/*.standalone.test.ts"`（本站原来的 glob 少了那个 `*`，模块里的 standalone 测试其实一直没跑到），并收下上游新增的 `test:web`。
- `tests/analysis-steps.ts`：`SELECTING_SCORE = selectionThreshold({ tier: "T1" })!`，本站的 `itemTypeName()` / `LAUNCH_ITEM_TYPE` 保留。
- `tests/analyze.test.ts`：本站夹具（车载 tags、`regulation`、`miit`）为准，并入上游的 `selectionThreshold` 导入与类别用例；上游那两个用例假设包里至少有一个门槛落在 T1 与 T2 之间的类别，本站 `classes` 是空的，所以第一个改成直接断言 `selectionThreshold` 的语义（无类别等于等级门槛、未知类别不抬、`EXCLUDE_MP` 为 null，再对每个真实类别断言取 `Math.max`），第二个加 `{ skip: CLASS === undefined && "this site's pack names no source classes" }`。
- `tests/discovery-scope.test.ts`：本站数据（`geely` / `vehicle` / `entity:geely`）+ 上游的新路径 `/sitemaps/topics.xml`。
- `apps/web/tests/cache.test.ts`：import 取并集（本站 `ReportCitation` / `ReportDetail` + 上游 `ADMIN` / `SIGN_IN_HOME`）。
- `apps/web/tests/report-ordinals.test.ts`：import 取并集（本站 `dotMark` / `opens` / `quietNote` + 上游 `chipLabel` / `neighbourLabel`），两边的用例都保留。

**本站 `browseFloor: 0` 与空 `classes` 的连带修改**（不补这些，上游新代码会在本站渲染出不存在的规定或跑红）：

- `packages/backend/src/publication/feeds.ts`：`LEFT_OUT` 里「`${SELECTION.browseFloor} 分以下条目`」改成只在 `browseFloor > 0` 时加（否则「全部动态」的 RSS 描述会写「0 分以下条目」，而本站一条都不挡）。
- `apps/api/src/routes/mcp.ts:80`：`mode=all` 的 describe 同样按 `browseFloor > 0` 拼「scoring N or more」，0 时不说。
- `tests/publication.test.ts:616`：上游新加的「全部动态在每个出口都挡掉门槛以下的资料」用例在本站会拿 `floor - 1 = -1` 当夹具，`{ skip: SELECTION.browseFloor <= 0 && "this site sets no browse floor" }`。
- `packages/backend/src/admin/gold.ts`（本站独有文件，上游没有）：`tierThreshold` 已被上游删掉，改成 `barOf(row) = selectionThreshold({ tier: row.sourceTier, selectionClass: row.sourceClass ?? null })`；`GoldScorable` / `SampleRow` / SQL / `saveGoldLabel` 的 INSERT 都补上 `selection_class`（门槛按判定当时的类别记下，以后改类别不会改写旧判定）。`tests/admin-gold.test.ts` 同步改成 `selectionThreshold({ tier: "T1" })!`。全仓已无 `tierThreshold`。

**同步面**：本轮**新开三个分叉面**，都已登记——`industry/prompts/translate-body-retry.md`、`industry/prompts/translate-body-rules.md`（本站按车载行业改写）、`packages/backend/src/publication/feeds.ts`（`LEFT_OUT` 按本站 `browseFloor: 0` 条件拼接）。按 §64 的跑法（`GIT_CONFIG_*` 关掉 rename 检测）重扫 `upstream/main..HEAD`：**157 个会被同步覆盖的文件、3 个未登记**，补完登记后重扫 **0 个未登记、SYNC SURFACE COVERED**。

上一节（2026-10-28）记的三个测试文件里，`tests/sign-in-paths.standalone.test.ts`、`apps/web/tests/report-year.test.ts`、`apps/web/tests/day-header-year.test.ts` 都已被上游删除（断言并进别的文件或直接不再保留），这三条登记作废，同 §`tests/selection-input.test.ts` 的先例。

迁移撞号按 AGENTS.md 的规则不冲突：上游新增 `database/migrations/{0090_source_selection_class,0091_feedback_kind,0092_feedback_idea,0105_source_uses}.sql`，本站 `modules/subscriptions/migrations/` 有 `0090_reader_users`–`0093_reader_deliveries`；按完整文件名排序执行，同号不同文件分别跑。`0040`/`0041`/`0056`/`0057`/`0085`/`0086`/`0090`/`0091`/`0092` 这些跨目录撞号是历史既有的。

`.env.example` 自动合并，两边项都在：上游 `WEBHOOK_HUB_URL`(:89)、`WEBHOOK_HUB_KEY`(:90)，本站 `LLM_MAX_CONCURRENCY`(:33)、`LLM_REASONING_TOKENS`(:37)、`LLM_TIMEOUT_MS`(:40)、`FEISHU_READER_PUSH_ENABLED`(:97)。

**门禁**（2026-11-02）：

- `npm run typecheck`：八段全绿（web 的 `react-router typegen` 在受限沙箱里 spawn 子进程 EPERM，放开后过，与代码无关）。
- `npm run build -w @aihot/web`：过，server bundle **811.08 kB**（gzip 209.52 kB）。
- 本地 `node --test --test-concurrency=2 "apps/web/tests/*.test.ts"`：**77 / 77 全绿**（上一轮 82 条，但上游把 `day-header-year.test.ts`、`report-year.test.ts` 并进 `report-ordinals.test.ts`，文件数从 17 变 15，条数不可直接比）。
- 本地 `npm run test:standalone`：**242 条 / 240 绿 / 2 红**——`outbound direct keeps larger response headers confined to one host` 与 `outbound proxy keeps larger response headers confined to one host`，还是 §48/§56/§64 记过的同一条 Windows libuv 断言（`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76`，子进程 exit 3221226505）。上一轮这条红名单里还有 `outbound-protocol`，本轮没有；按名字判，两个文件本轮合并都没改过。
- 根套件（连库）**未跑**：本机没有 Postgres、Docker daemon 没起（`docker ps` 连不上 `npipe:////./pipe/dockerDesktopLinuxEngine`），按 §64 先例待服务器车道复跑补。
- `git diff --check` 只剩 `tests/collection-body-preservation.test.ts:73: new blank line at EOF.`——该文件与 `upstream/main` 逐字节相同（`git hash-object` 两边都是 `6b1b9890…`），是上游自带的，不是本轮引入，CI 也不查 whitespace，不改。

**回滚**：`git reset --hard pre-sync-20261102-dev`（`aa982c2`）。

**未部署、未推送 origin**：`dev` 只在本机（`origin/main` = `upstream/main` = `38d130f`）。下一步等使用者定：是否跑服务器车道、是否部署上线、是否把 `dev` 推到 `origin`。
