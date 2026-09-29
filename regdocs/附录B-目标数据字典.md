# 附录 B — 目标数据字典

| 项 | 值 |
|---|---|
| 文档编号 | REG-APX-B（隶属 REG-DSG-02 §3） |
| 版本 | v2.0 / 2026-09-29 |
| 上游 | `02-设计文档.md`（REG-DSG-02 v2.0） |
| 权威来源 | `<RW>/config/{table_schema,blacklist_schema,faq_schema}.json`（逐字读取）、`<RUN>/contract.json`、`<RUN>/original_docs/README.md`、`<RW>/config/kb_configs.json`、AIHOT 迁移 `0001`–`0038` |
| 作用 | ① 现存储 31 字段的逐项语义与枚举（迁移基准）；② 目标表全字段；③ 迁移映射；④ **四方枚举一致性矩阵** |

> **v2.0 变更说明**：架构从"重型法规实体层"转为"模块增强 AIHOT 事件层"。§5 已全面重写：`regulation_families` + `regulations`(21+26 列) + `regulation_lineage` + `regulation_review` + `user_capabilities` 等 8+ 张重型表替换为 4 张轻量模块表（`regulation_tracking` 20 列 + `regulation_article_links` + `regulation_status_history` + `exclusion_list`）+ `documents`。§8 步骤引用从 M1–M7 更新为阶段编号。

> 现存储字段描述中标注了"V2.1 / V2.2 定版 2026-09-16"这类版本记号，它们是判据的一部分，**不得在迁移中被简化掉**。

---

## 1 现存储：法规主表（迁移基准）

| 项 | 值 |
|---|---|
| 表 | 信源表_v2.0 |
| 标识 | 应用 `VBcRbUgETasPxdsBHOEcbT0wndd` / 表 `tblMHJCpipvyRaNJ` |
| 业务主键 | `法规编号`（`unique_key` + 主字段） |
| 记录数 | 73（以 2026-09-17 全量导出的 manifest 为准；文档中另见 62/63/65/71/72 等历史值，**视为移动量而非固定值**） |
| 字段数 | **31**（29 业务 + 2 系统只读） |

### 1.1 字段清单

| # | 字段 | 类型 | 必填 | 枚举 / 约束 | 语义要点（含版本记号） | 目标列 |
|---|---|---|---|---|---|---|
| 1 | 法规编号 | text | ✔ 唯一 主 | — | 规范化写法示例：`GB/T 4495-2024` / `UN R155` / `EU 2024/1234` / `ISO 26262` / `Euro NCAP 2026` / `FMVSS 127` / `CNCAP-2027` | `code_norm`（`norm_num` 输出，连接键） |
| 2 | 法规全称 | text | ✔ | — | — | `title` |
| 3 | 地区 | select | ✔ | 28 项（见 §4.1） | **最小适用地区**（V2.2 定版 2026-09-16）：明确面向某国标该国（日本 JNCAP/TRIAS、韩国 KNCAP/KMVSS、美国 FMVSS）；多国联盟或未指明才用大区（欧洲=EU、东南亚=ASEAN、联合国/UNECE=UN R/ISO） | 暂存 `regulation_tracking` 扩展列或 `articles` 结构化字段 |
| 4 | 业务分类 | multi_select | ✔ | 8 项：`DMS` `OMS` `脱敏` `信息安全` `哨兵` `ADAS` `AVM` `功能安全` | 一级分类，**涉及就标、顺序=法规中优先级/比重**；碰撞类一律归 OMS；**纯硬件法规可为空**（V2.1 起无"通用"兜底） | `articles` 标签体系（由 `industry/taxonomy.ts` 承载） |
| 5 | 算法标签 | multi_select | — | 38 项（见 §4.2） | 二级分类：先命中一级，再从摘要/原文摘功能词；法规未细分到算法时只打一级 | `articles` 标签体系 |
| 6 | 适用国家 | multi_select | — | 2 项（见 §4.3） | 支撑"问具体国家 ⇒ 附带其大区法规"，大区↔国家映射见 `分类地区判定标准_v0.2` | 暂存扩展列 |
| 7 | 生命周期阶段 | select | ✔ | 6 项，**有序、不可回退** | 只描述法规状态；状态机见 `state_machine` | `lifecycle_state`（CHECK 取值域 + 写路径守卫转移 + `regulation_status_history`） |
| 8 | 修订日期 | date | 条件 ✔ | `生命周期=已修订` 时必填 | 最近一次修订/更新（UN Supplement、GB 修订版）的发布日期 | `revised_on` |
| 9 | 发布日期 | date | 条件 ✔ | `生命周期=正式发布` 时必填 | "解析不到留空" | `published_on` |
| 10 | 实施日期 | date | — | **禁止自由文本** | — | `effective_on`（BR-12 精度守卫的主战场） |
| 11 | 征求意见截止日期 | date | 条件 ✔ | `生命周期=征求意见稿` 时必填 | — | `comment_deadline` |
| 12 | 报批稿截止日期 | date | — | — | — | 暂存扩展列或省略 |
| 13 | 发布机构 | text | ✔ | — | 工信部 / 全国汽标委 / 中汽测评 / 联合国WP.29 / NHTSA …；由域名推导时**按域名长度降序匹配**（X-07） | 暂存扩展列 |
| 14 | 核心摘要 | text | ✔ | 50–100 字 | — | `articles` 摘要（平台既有机制） |
| 15 | 影响评估 | text | ✔ | — | 对开发/测试/认证的影响；**商业敏感**（FR-08-06 字段遮蔽对象） | `articles` 结构化字段 |
| 16 | 适用车型 | text | — | — | M1/N1/M2/M3/N 类 | 暂存扩展列 |
| 17 | 印证状态 | select | ✔ | 3 项：`已印证` `待印证` `待核实` | **由信源层级推导**：T1→已印证、T2→待印证、T3/未分级→待核实 | `corroboration`（由 `industry/regulation/evidence.ts` 派生） |
| 18 | 印证策略 | text | — | — | T1/T2/T3 相互印证规则的文字（来自 13 个信源策略模板） | 暂存扩展列 |
| 19 | 信源T1-官方 | text | ✔ | — | 官方 URL，**出现即采信** | `source_t1_url`（暂存扩展列） |
| 20 | 信源T2-行业 | text | — | — | 行业机构 URL | 暂存扩展列 |
| 21 | 信源T3-资讯 | text | — | — | 媒体/自媒体 URL | 暂存扩展列 |
| 22 | 原文链接 | text | ✔ | — | 优先级：正文直链 > 统一下载页 > 官网首页；落表自动填来源 URL，无来源时从信源模板提域名兜底。**非空后不再被覆盖**（BR-13） | `origin_url` + `origin_locked boolean` |
| 23 | 原文入库 | select | ✔ | 3 项：`已入库` `未入库` `受限` | 2026-08-24 新增 | 与 `documents` 对账可自动推导，故不重复存储状态 |
| 24 | 原文获取方式 | select | ✔ | 6 项：`PDF直链下载` `网页在线阅读` `需注册` `付费购买` `第三方摘要` `暂无原文` | 自动判定见 X-06 | 暂存扩展列 |
| 25 | 订阅状态 | select | ✔ | 3 项：`待评审` `高频监控` `稳定低频` | **受保护字段**：人工置为后两项后自动流程不得改回（BR-18，`upsert_preserve`） | `subscription_state` + `LIFECYCLE.upsertPreserve` 守卫 |
| 26 | 法规认证类型 | select | ✔ | 7 项：`强制` `推荐` `新车评价` `准入法规（强制）` `如有需符合` `自愿（可选E-mark）` `待评审` | 人工评审定版 2026-09-08；判不出置"待评审"；判定规则见 X-05 | `cert_type` |
| 27 | 解读状态 | select | ✔ | 3 项：`未认领` `解读中` `已沉淀` | 认领互斥（FR-02-04） | 阶段四模块扩展 |
| 28 | 认领人 | user（多选） | — | 值须以 `ou_` 开头 | 负责解读的工程师 | 阶段四模块扩展（外键到本地用户表） |
| 29 | 上次检查日期 | date | ✔ | — | 低频轮询：上次 T1 原文校验日期；落表自动填当天 | `last_check_on` |
| 30 | 创建时间 | created_at | 系统 | **只读、永不写、永不镜像** | 存储方维护 | — 用目标库 `created_at`；**不从飞书投影** |
| 31 | 更新时间 | updated_at | 系统 | 同上 | 同上 | — 同上 |

**已核实的类型映射与陷阱**（迁移器必须照搬的三条）：

1. 内部类型 `date` 对应实际存储的 `datetime` 类型；读取时按毫秒纪元或带时区 ISO 归一回 `YYYY-MM-DD`。
2. 内部类型 `multi_select` 对应实际的 `select` + `multiple=true`——**`multiple` 必须单独比较**，否则一致性检查会把多选字段误判为类型不符。
3. 用户字段的扁平化读取有已知缺陷：`user` 数组被展平后即使有值也读成 `null`。**凡涉及认领人/决策人的校验必须走单条读取**，不能只信列表接口的扁平结果。

---

## 2 现存储：排除清单

| 项 | 值 |
|---|---|
| 表 | 不关注清单 / 表 `tblcBC17PLfrF1fi`（同一应用） |
| 主键 | `法规编号`（规范化写法同主表；示例含 `2026271-T-339` 这类计划号） |
| 状态机 / 条件必填 | 无 |

| 字段 | 类型 | 必填 | 目标 |
|---|---|---|---|
| 法规编号 | text | ✔ 唯一 | `exclusion_list.code_norm`（`scope='regulation'`） |
| 法规全称 | text | ✔ | 记录在同表 `reason` 旁的冗余列或经关联取 |
| 决策日期 | date | ✔ | `decided_on` |
| 决策原因 | text | — | `reason` |
| 决策人 | user | — | `decided_by`（归因为 `feishu:<union_id>`，DES §6.3） |
| 来源链接 | text | — | `source_url`（描述原文："防再次检出的出处"） |

---

## 3 现存储：FAQ 归档（114 条）

表 `tblpwoSY4X3Evirq`（同一应用），主键 `记录ID`（`FAQ-0001` 递增，迁移时生成）。

| 字段 | 类型 | 必填 | 枚举 |
|---|---|---|---|
| 来源 | select | ✔ | `wiki表格-法规测试认证机构FAQ` / `Base-法规FAQ` |
| 业务 | multi_select | — | `DMS` `OMS` `AVM` `Assisted Driving` `其他`（⚠️ 与主表业务分类**不同集合**，见 §4.4） |
| 法规 | text | — | 原始值（`ENCAP26`/`OMS`/`ADDW`/`CNCAP` 等，未规范化） |
| 问题描述 | text | ✔ | — |
| idiada答复 / CSI答复 / UTAC答复 / 内部答复 | text | — | 四家分开存，**不合并**（跨机构差异本身是信息） |
| 问题定性 | select | ✔ | `正常咨询`（法规有明确答案）/ `法规空白`（规程未说明）/ `表述模糊`（有规定但可多解或机构间不一致）/ `用户误读`（概念或体系混淆） |
| 定性依据 | text | — | 一句话，引用答复关键词 |
| 功能域 | select | — | `DMS` `OMS` `AEB` `AD` `CP` `PC` `其他`（LLM 标注，⚠️ 第三套分类词汇） |
| 跨体系 | select | — | `是` / `否`（是否需跨体系对比才能回答） |
| 提交人 / 提交时间 / 原表记录ID / 备注 | text, date | — | 回溯用 |

**目标**：留在知识层侧（FAQ 是问答资产，不是法规实体记录）。迁移脚本已 spent（其输入文件已不存在），保留仅为可追溯。三套分类词汇（主表 8 项 / FAQ 业务 5 项 / 功能域 7 项）的**归一**是阶段二的前置工作，不在本次范围。

---

## 4 枚举一致性矩阵（四方核对）

**这一节的存在理由是附录 A BR-22 记的那次真实故障**：字段定义文件里"法规认证类型"有 7 个选项，实际存储只有 6 个，导致所有"自动判不出"的记录写入失败并报 `not_found`。修法不是"记得对齐"，而是 §4.5 那条断言。

### 4.1 地区（28）

`中国` `欧洲` `联合国/UNECE` `东南亚` `澳大利亚` `北美` `东亚` `其他` ＝ 8 个大区
`日本` `韩国` `美国` `加拿大` `英国` `德国` `法国` `意大利` `西班牙` `荷兰` `比利时` `瑞典` `波兰` `泰国` `马来西亚` `印尼` `越南` `菲律宾` `新加坡` `新西兰` ＝ 20 个国家
合计 **28**。

### 4.2 算法标签（38）

按一级分类归组：疲劳检测 / 分心检测 / 失能检测 / 接打电话检测 / 视线·注视估计 / 驾驶员存在检测 / 儿童存在检测(CPD) / 儿童遗留检测 / 乘员体型估计 / 安全带检测(SBR) / 离座检测 / 气囊抑制判断 / 乘员姿态估计 / 人脸脱敏 / 车牌脱敏 / 生物特征脱敏 / 数据最小化 / 数据本地化·跨境 / 网络安全管理 / 软件更新管理 / 密码应用 / 入侵检测 / 驻车监控 / 碰撞后通知 / AEB / LKA / ACC / ELKS / ISA / 泊车辅助 / 盲区检测(BSD) / 预警（FCW·LDW） / 全景拼接 / 近距障碍物检测 / 盲区可视 / ASIL 等级 / SOTIF / AI 安全 ＝ **38**。
（该清单在 `<RW>/config/table_schema.json` 与 `<RW>/parse_llm.py:27-34` 各存一份，靠人工同步——迁移后由生成器消除双源。）

### 4.3 适用国家（22）

`中国` `德国` `法国` `意大利` `西班牙` `荷兰` `比利时` `瑞典` `波兰` `英国` `澳大利亚` `新西兰` `泰国` `马来西亚` `印尼` `越南` `菲律宾` `新加坡` `日本` `韩国` `美国` `加拿大` ＝ 22。

⚠️ 注意它**不等于** §4.1 里那 20 个国家：`韩国` `日本` 等在两处都有，但 §4.1 含 `北美`/`东亚` 等大区派生项、§4.3 无 `其他`。这两个字段**不是同一维度**（一个是法规的最小适用地区、一个是实际适用国家清单），不要合并。

### 4.4 五处分类词汇并存（现状，勿混淆）

| 词汇集 | 项数 | 出现处 |
|---|---|---|
| 业务分类 | 8 | 主表 |
| 算法标签 | 38 | 主表 |
| 事件的一级分类（平台 CATEGORIES） | 由行业包定义 | 门户导航、报告分区、订阅出口 |
| FAQ 业务 | 5 | FAQ 表（含 `Assisted Driving`、`其他`，与主表 8 项**不同集合**） |
| FAQ 功能域 | 7 | FAQ 表（LLM 标注，含 `AEB`/`AD`/`CP`/`PC`） |

**本次的约束**：主表 8 项与算法 38 项是**业务分类的权威词汇**，行业包的 CATEGORIES 与标签词汇集合必须**由它派生**（同一生成器），不得另立。FAQ 两套词汇本次不动，归一列入阶段二前置。

### 4.5 断言（必须实现，DES §3.9）

`tests/industry-contract.test.ts` 四方核对，任一不符即红：

1. 数据库目录中的实际约束取值（每个 `CHECK` 与枚举域）；
2. 行业包内定义的分类 / 标签 / 阈值层级；
3. `LIFECYCLE.order` 与条件必填引用到的字段；
4. 投影映射文件的选项集合。

---

## 5 新增：目标表全字段（v2.0 轻量方案）

### 5.1 法规追踪表（`regulation_tracking`，20 列）

来自 DES §4.2 DDL。相对现存储的**核心变化**：不再拆 `regulation_families` + `regulations` 两张表，族信息（`family_key`）直接内嵌于追踪表；子项关系由 `regulation_article_links` 桥接。

```sql
CREATE TABLE regulation_tracking (
  id              bigserial PRIMARY KEY,
  code_norm       text NOT NULL UNIQUE,       -- 规范化法规编号
  family_key      text NOT NULL,              -- 编号基干（归族键，BR-07/08/09）
  title           text NOT NULL,
  lifecycle_state text NOT NULL DEFAULT '起草中'
    CHECK (lifecycle_state IN ('起草中','征求意见稿','报批稿','正式发布','已修订','已废止')),
  published_on    date,
  effective_on    date,
  comment_deadline date,
  revised_on      date,
  cert_type       text NOT NULL DEFAULT '待评审',
  corroboration   text NOT NULL DEFAULT '待核实',
  subscription_state text NOT NULL DEFAULT '待评审'
    CHECK (subscription_state IN ('待评审','高频监控','稳定低频')),
  origin_url      text,                       -- 官方原文链接
  origin_locked   boolean NOT NULL DEFAULT false,  -- BR-13
  source_tier     text,                       -- 首次报道的信源层级
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_check_on   date NOT NULL DEFAULT current_date,
  row_hash        text,                       -- BR-14
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

相对现存储的**新增列**及理由：

| 新增列 | 为什么必须有 |
|---|---|
| `family_key` | 归族成为数据（BR-07/08/09），不再需要独立的 `regulation_families` 表 |
| `origin_locked` | 官方链接不覆盖（BR-13） |
| `row_hash` | 零差异即零写入（BR-14） |
| `first_seen_at` | 停留天数读时推导（X-04） |
| `source_tier` | 信源层级直接记录（BR-22） |

**相对 v1.0 方案删除的列**：`code`（原始编号，不再双存）、`region`/`issuing_body`/`vehicle_scope` 等暂存于 `articles` 标签或扩展列、`*_precision` ×3（精度守卫改为写路径层实现，不再用独立列）、`guard_note`/`guard_waived_by`（存量违规收容改为导入报告）、`record_type`/`parent_id`（子项关系由 `regulation_article_links` 承载）、`interpretation_state`/`assignee_user_id`（阶段四模块扩展）。

### 5.2 其余新表（详见 DES §4）

| 表 | DDL 位置 | 作用 | 承载的规则 |
|---|---|---|---|
| `regulation_article_links` | DES §4.2 | 报道 ↔ 法规桥接（`regulation_id` + `article_id` + `relation`） | BR-10 子项关系、§4.1 双对象模型 |
| `regulation_status_history` | DES §4.2 | append-only 状态迁移史，带 `origin`（model/rule/manual/import）与 `actor` | BR-03 状态机、BR-08 替代语义 |
| `exclusion_list` | DES §4.5 | 四域排除表（topic/regulation/pattern/source），撤销不删除 | BR-01 排除清单、BR-17、X-16 |
| `documents` | DES §5.2 | 原文目录：sha256 内容寻址、`regulation_id` 关联、`parse_state` 状态机、`restricted` 受限标记 | FR-04-05/06/07、DES §1.3 写路径铁律 |

**相对 v1.0 方案删除的表**：`regulation_families`（族信息内嵌 `regulation_tracking.family_key`）、`regulations`（拆为 `regulation_tracking` + `articles` 标签）、`regulation_lineage`（替代关系由 `regulation_status_history` + 匹配器承载）、`regulation_review`（评审队列直接读 `regulation_tracking` + `regulation_status_history`）、`user_capabilities`/`capability_groups`/`api_tokens`（阶段一先做企业登录 + 基础角色，细粒度 RBAC 后续迭代）。

**复用不改的 AIHOT 既有表**：`sources` `articles` `article_revisions` `article_discoveries` `analyses` `facts` `stories` `fact_articles` `publications` `reports` `report_revisions` `receipts` `receipt_attempts` `budgets` `service_prices` `embeddings` `notify_targets` `deliveries` `job_runs` `fetch_runs` `audit_log` `stored_files` `editorial_overrides` `grouping_overrides`

### 5.3 身份映射

企业身份（`union_id` / `open_id` / 邮箱）↔ 本地用户表：沿用平台既有的登录 upsert 路径（按 `feishu_union_id`/`email`），审计与决策记录里存**归因串**（`admin:<id>` / `feishu:<union_id>` / `token:<label>` / `pipeline` / `rule`），不存裸 ID。现存储的用户字段格式（`ou_` 前缀）在投影时由映射表还原。

---

## 6 契约与配置对象的归宿

| 现对象 | 内容 | 归宿 | 处置 |
|---|---|---|---|
| `<RUN>/contract.json` v0.2 | 分级定义、印证规则、观察清单（RSS 5 / 爬取 4 / 固定域 7 / 关键词约 50 / 事件类型 5）、节奏、**重要性门槛**（=BR-01 全文）、受众、输出与归档、爬取环境 | 拆为四处（DES §6.4） | **⚠️ 已知双源**：`watchlist.crawl_sources` 只是描述性文字，**没有任何代码读它**，每个爬虫各自硬编码自己的配置；且实际生产的两个通道（国家标准委动态、无编号候选通道）**根本不在契约里**。迁移时以真实注册表为准反向重写，不要移植一个说谎的配置文件 |
| `<RW>/config/table_schema.json` | 主表 31 字段 + 状态机 + 条件必填 + upsert_preserve + 唯一键 | 生成 `industry/regulation/lifecycle.ts` 与 `projection/bitable.json` 后**冻结**；作为测试固定语料保留 | 它是本次重构的**规格文件**，不是待清理的旧配置 |
| `<RW>/config/blacklist_schema.json` `faq_schema.json` | 见 §2 §3 | 排除表 / 知识层 | — |
| `<RW>/config/kb_configs.json`（92 KB） `kb_config_schema.json` `agent_configs.json`（72 KB） `agent_schema.json` | 知识层库配置与 Agent 配置的**配置驱动管理** | 留在知识层侧 | 已是正确的形态（配置即代码 + 一个工具集来 build/upload/snapshot）；嵌入模型 ID 是运行时事实，必须 pin 进 `industry/regulation/weknora.ts` 并在上传前断言（DES V5） |
| `<RUN>/state.json` | `last_cutoff`（**仍停在 2026-08-20**）+ `seen_urls`（上限 5000，字典序截断） | 平台身份键 + 发现账本 | `last_cutoff` 已失去意义；`seen_urls` 的行为是 X-14 描述的随机遗忘 |
| `<RUN>/events.json`（17.6 MB） | 活跃事件库，含 8192 维向量 | 转为阶段一 1.3 聚类对拍的**固定语料**，之后不进生产路径 | ⚠️ 体积主要由浮点向量构成，且无界增长 |
| `<RUN>/weekly_issue.json` | `{issue, updated}`（当前 7 / 2026-09-28），自然日内幂等自增 | 报告期号派生 + 保留兼容 | 期号语义（连续编号、幂等）必须原样保留 |
| `<RUN>/original_docs/` | `index.json`（约 69 条）+ `{cn,eu,un,us,other}/<DIR>/{原文.pdf, 原文.md, meta.json}`；meta 含哈希、下载日期、本地路径、解析状态 | `documents` + `stored_files` | 内容哈希成为与知识层的连接键；中国分区约 25 个子目录 |
| `<RUN>/archive/YYYY-MM-DD/` + `manifest.json` | 43 个日目录 | 黄金语料（PLN §6 G6） | **先转固定语料再动手** |
| `<RUN>/feds/sync_report.json` | 三分类明细（最近一次：交集 58 / 变更 1 / 无变化 57 / **守卫拦截 54**） | 法规同步运行日志 | 这份真实输出是阶段二 2.3 判据①最好的对照样本；"守卫拦截 54 vs 变更 1"也说明守卫密度之高 |

---

## 7 目标库的信源层级映射（需求 O-4 的落地）

| 现三级 | 目标层级 | 参与模式 | 效果 |
|---|---|---|---|
| T1 权威官方 | `T1` | `editorial` | 可入选、可写表 |
| （新增区分）官方账号 / 机构官方页 | `T1_5` | `editorial` | 阈值介于两者之间 |
| T2 行业机构 | `T2` | `editorial` | 高阈值入选；单源出现 ⇒ 印证状态待印证 |
| T3 资讯与公众号 | `T3`（在"是否入选"意义上等价于**不设阈值**的层级） | `hot_signal` | **只进候选池与热度，不进精选、不写表** |
| — | 任意层级 | `isolated` | 影子回放专用：够不到任何公开面 |

⚠️ 目标层级枚举不含 `T3`，因此"T3"必须表达为"该层级不设入选阈值"+"参与模式为信号"两个正交属性，而不是硬塞一个枚举值。这正是"不单独成文"（BR-22）的机制化形式。

---

## 8 迁移映射与验收

| 步骤 | 映射 | 验收（对应 PLN 阶段二） |
|---|---|---|
| 阶段二 2.3 主表导入 | 31 列 → `regulation_tracking`（20 列）+ `articles` 标签体系；两个系统列不迁移 | 行数 1:1；逐格 diff 空；**两种顺序导入得同一 `row_hash`** |
| 阶段二 2.5 排除清单 | 6 列 → `exclusion_list(scope='regulation')` | 每条含决策人/日期/原因三件套（BR-17 要求） |
| 阶段二 2.4 归族 | 由 `code_norm` 反推 `family_key`（BR-07 判据一）+ NCAP 代际按 BR-09 判为不同族 | 归族划分人工抽查全量（73 条规模可穷举）；NCAP 代际命中数与预期一致 |
| 阶段二 2.4 替代关系 | 摘要中"被 XX 替代"文本 → `regulation_status_history(to_state='已废止', origin='rule')` | 每条替代边有匹配器判断记录 |
| 阶段二 2.3 违规报告 | 条件必填缺失、状态倒退、编号疑似全称兜底（X-01） | 输出**清单**不中断（PLN G4）；每条给出建议处置 |
| 阶段三 3.3 原文 | `original_docs` 逐目录 → `documents`（按 sha256） | 目录数与索引数一致；受限项被标记 |
| 阶段三 3.4 知识层对账 | 既有知识层对象 ↔ `documents`（哈希或文件名） | 双向孤儿为 0 或有具名处置清单 |

**遗留脏数据的预期**：违规报告一定会报出若干条（编号是长文本的、缺发布日期却已正式发的、同族状态倒挂的）。**这正是阶段二 2.3 存在的意义**——在零风险时知道，而不是在生产运行时知道。
