# RegPilot → AIHOT 派生开发 Prompt

> 本 prompt 供 AI 编码助手在 AIHOT 派生仓库上进行开发时使用。
> 它浓缩了 `regdocs/` 下五份文档（v2.0）的核心决策与约束。
> 完整规格以 regdocs 原文为准，本文件是执行层的快速参考。

---

## 你的角色

你正在开发一个**车载行业动态与法规知识平台**，基于开源项目 AIHOT 的派生（fork）。

AIHOT 是一个 TypeScript monorepo（Node.js 24 + PostgreSQL 17 + npm workspaces），核心能力是：信源采集 → 身份/版本 → 聚类 → 双评分 → 摘要 → 报告 → 门户 SSR。

你的任务是把 AIHOT 从通用信息平台改造成**车载行业平台**，并逐步增加法规追踪、原文库、解读/对比/问答等模块。

---

## 核心原则（违反任何一条都要停下来重新想）

1. **`industry/` 包是唯一行业定制面**。核心管线代码（`packages/backend/src/`）的改动必须是追加式的（新模块、新端点），不改既有函数签名与数据流。
2. **法规实体绝不能建模为 AIHOT 的 `stories`/`facts`**。那是 14 天召回窗口的事件层。法规元数据通过模块级追加表（`regulation_tracking` 等）承载，桥接到事件层。
3. **`publications` 表一行都不能改**。`publish.ts:246-279` 的 29 元组 `INSERT ... IS DISTINCT FROM` 是手工维护的，漏一个元素 ⇒ revision 单调膨胀 ⇒ 下游抖动。
4. **Python 永不直插平台数据库**。RegPilot 与平台之间只走 HTTP/JSON。
5. **浏览器永不进平台进程**。需真实浏览器的信源（EUR-Lex/IVISTA/CATARC）做成外部推送器，`POST /api/ingest/items`。
6. **投影单向**：Postgres → 飞书表、Postgres → WeKnora、Postgres → 卡片。投影永不成为数据源。
7. **删除优于关闭**：AIHOT 自带的模型榜单与额度监控模块直接删除，不保留配置关闭。

---

## 项目结构（你需要动的部分）

```
AIHOT/
  industry/                    ← ★ 主要着力面：替换全部内容
    site.ts                    ← 站点身份与品牌
    taxonomy.ts                ← 车载分类体系与标签枚举
    sources.json               ← 全部信源注册（声明式）
    topics.json                ← 话题与关键词
    selection.ts               ← 入选阈值 + 法规权重系数
    features.ts                ← 功能开关
    prompts/*.md               ← 全部提示词
    brand/                     ← 门户品牌配置
    regulation/                ← ★ 阶段二新增
      lifecycle.ts             ← 六状态状态机
      relevance.ts             ← 三层合取判定 + 排除词汇
      identity.ts              ← code_norm / 族前缀 / 子项标记
      evidence.ts              ← 层级 → 印证状态
      weknora.ts               ← 库 ID + 嵌入模型 pin
      parser-config.ts         ← 阶段三：解耦解析器接口
  packages/backend/src/
    regulation/                ← ★ 阶段二新增：法规模块业务代码
  media/documents.ts           ← ★ 阶段三新增：原文库
  apps/web/src/pages/          ← ★ 新页面：法规列表/详情/评审/原文库/解读/对比
  regdocs/                     ← 设计文档（只读参考）
```

---

## 五阶段交付路线

### 阶段一：行业动态（当前阶段）

**目标**：替换 `industry/` 包，把 AIHOT 变成车载行业平台。核心管线零改动。

1. **派生仓库**：fork + 保留 upstream remote + 写 `FORK-CHANGES.md` + 删除榜单与额度监控模块
2. **测试去污染**：29 个测试里硬编码的行业分类/标签改为从 `industry/` 包导入
3. **industry/ 包替换**：
   - `sources.json`：SAC(json_list) / C-NCAP(json_list×5) / MIIT(rss) / UNECE(rss) / Euro NCAP(rss) / 中汽中心(web_list) 等
   - `taxonomy.ts`：法规动态 / 新车发布 / 技术落地 / NCAP 评测 / 客户动态 / 行业标准
   - `topics.json`：车载关键词 + 排除词汇（BR-01 九类排除）
   - `selection.ts`：入选阈值 + 法规权重系数
   - `prompts/*.md`：结构化解析（含三层相关性判定）/ 摘要 / 报告撰写
   - `brand/`：门户名称与品牌
4. **采集适配器**：零新增 kind（json_list/rss/web_list + 外部推送器）
5. **门户与报告**：资讯流 + 标签筛选 + 日报/周报自动生成 + 内容 feed 端点
6. **运营基线**：预算(per_minute=36) + 告警 + doctor 自检

### 阶段二：法规动态（模块增强）

在事件层之上增加法规元数据追踪。4 张模块表：
- `regulation_tracking`（20 列，法规元数据 + 生命周期 + 守卫字段）
- `regulation_article_links`（桥接事件层）
- `regulation_status_history`（append-only 迁移史）
- `exclusion_list`（四域排除：topic/regulation/pattern/source）

关键守卫（必须实现为写路径上的 TS 函数，不用数据库触发器）：
- 六状态只进不退（BR-03）
- 条件必填（BR-04）
- 精度不降级（BR-12）
- 官方链接不覆盖（BR-13）
- 零差异即零写入（BR-14）
- 订阅状态受保护（BR-18）
- 排除清单读取失败 ⇒ 整个流程中止（BR-17）

### 阶段三：原文库

- `documents` 表：sha256 内容寻址 + parse_state 状态机
- `DocumentParser` 接口：默认 MinerU Cloud，解耦可替换
- 原文上传 → 解析 → 推送 WeKnora → 门户检索
- 受限原文不进对外出口

### 阶段四：解读·对比·问答

- 三个独立模块在新页面展示
- 双向链接关联法规动态/解读/对比/问答
- 引用必须回链到门户永久链接 + 页/条款定位

### 阶段五：个性化

- 角色配置关注的业务分类/标签
- 个性化 feed + 个性化推送

---

## 关键业务规则速查（完整清单见附录A）

| 编号 | 规则 | 实现要点 |
|---|---|---|
| BR-01 | 三层相关性判定（车载 ∧ 含软件 ∧ 我方业务）+ 九类排除 | `industry/prompts/` 提示词 + `regulation/relevance.ts` 代码闸门 + `exclusion_list(scope='topic')` |
| BR-03 | 六状态只进不退 | `lifecycle.ts` CHECK + 写路径守卫 + `regulation_status_history` |
| BR-06 | 日期 ISO；实施日期禁自由文本；月精度留空不填 01 | `*_precision` 列 + `identity.ts` 归一 |
| BR-07 | 编号基干相同 ⇒ 同族 | `identity.ts` 确定性匹配器 + `regulation_tracking.family_key` |
| BR-09 | NCAP 代际 ⇒ 不同族 | `family_kind='ncap_scheme'` |
| BR-10 | 子项不单独追踪（三态） | `record_type` + 词边界保护 + 最长前缀优先 |
| BR-12 | 精度不降级 | `*_precision` + 守卫函数 |
| BR-13 | 官方链接不被转载页覆盖 | `origin_locked` 布尔 + 守卫函数 |
| BR-14 | 零差异即零写入 | `row_hash` + `sync_revision` |
| BR-17 | 排除清单失败即中止 | `exclusion.ts` 读失败即抛 |
| BR-18 | 订阅状态受保护 | `upsertPreserve` 守卫 |
| BR-22 | 信源分级与印证 | `evidence.ts`：T1→已印证、T2→待印证、T3→待核实 |
| BR-25 | 面向读者重写，禁内部管理表述 | 直接采用平台 `rules-anti-hallucination.md` 的 9 条规则 |
| BR-28 | 卡片单一生成器 | 唯一渲染器 + 断言 |

---

## 采集适配器裁决

| 站点 | 机制 | 配置要点 |
|---|---|---|
| SAC / 国标委 | `json_list` | `mode:'html_window_var'`, `publishedAtUnit:'yyyymmdd'` |
| C-NCAP | `json_list` × 5 源 | `method:'POST'` + `bodyJson` + `headers` + `jsonKey` |
| MIIT | `rss` × 2 | RSSHub 镜像 + 原生 RSS |
| UNECE / WP.29 | `rss` + `web_list` | |
| Euro NCAP | `rss` | |
| EUR-Lex | **外部推送器** | TLS 指纹/WAF |
| IVISTA / CATARC | **外部推送器** | 需真实浏览器 |
| 中汽中心 / 标准化 | `web_list` | 选择器列表 |

**零新增 kind。** 需浏览器的做推送器，永不进平台进程（7GB 机器）。

---

## 开发时的注意事项

1. **测试去污染先于行业包替换**（G5）：先把 29 个测试里硬编码的示例行业数据改为从 `industry/` 包导入，否则换包后无法区分真回归与示例污染。
2. **黄金语料在阶段二启动前交付**（G6）：从 regwatch 归档提取守卫用例集，变成表驱动的可执行测试。
3. **存量数据违规只报告不阻断**（G4）：导入期守卫出校验报告，约束在违规清零后单独启用。
4. **两套向量平面必须隔离**（V5）：AIHOT 侧向量永不出召回窗口，WeKnora 的向量永不回答门户列表。
5. **`analyses.origin` 原生支持 `'rule'`**（V6）：确定性判断用 `origin='rule'` 记，模型只做建议。
6. **内网出访**（V3）：不开 `ALLOW_PRIVATE_NETWORK_FETCH`，用 `INTERNAL_EGRESS_ALLOW` 窄白名单 + `route:"direct"`。
7. **全局模型客户端加容量 5 的信号量**（P3）：预算表达不了并发。

---

## 参考文档位置

| 文档 | 路径 | 内容 |
|---|---|---|
| 需求文档 | `regdocs/01-需求文档.md` | 完整功能需求 + 非功能需求 |
| 设计文档 | `regdocs/02-设计文档.md` | 架构、模块设计、DDL、跨边界契约 |
| 实施方案 | `regdocs/03-重构实施方案.md` | 五阶段交付计划、全局规则、风险登记册 |
| 业务规则溯源 | `regdocs/附录A-业务规则溯源.md` | BR-01…BR-30 + X-01…X-22 逐条对齐 |
| 目标数据字典 | `regdocs/附录B-目标数据字典.md` | 现存储 31 字段 + 目标表全字段 + 枚举矩阵 |

**当本 prompt 与 regdocs 原文冲突时，以 regdocs 为准。**

---

## 当前任务

现在处于**阶段一：行业动态**。按 `regdocs/03-重构实施方案.md` §3 的步骤顺序执行：

1.1 派生仓库 → 1.2 测试去污染 → 1.3 industry/ 包替换 → 1.4 采集适配器 → 1.5 门户与报告 → 1.6 运营基线 → 1.7 飞书投影

每完成一步，对照该步骤的验收条件确认通过后再进入下一步。
