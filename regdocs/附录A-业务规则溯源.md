# 附录 A — 业务规则溯源

| 项 | 值 |
|---|---|
| 文档编号 | REG-APX-A（隶属 REG-REQ-01 §6） |
| 版本 | v2.0 / 2026-09-29 |
| 上游 | `01-需求文档.md`（REG-REQ-01 v2.0）、`02-设计文档.md`（REG-DSG-02 v2.0） |
| 作用 | 把 `REG-REQ-01 §6` 的 **BR-01 … BR-30** 逐条对齐到「原文位置 / 当前语义 / 目标落点 / 来源事故」，并额外收录 22 条未进需求正文但同样不能丢的规则（编号 `X-01 … X-22`）。本表是实施计划 G1（Python 为基准）可执行的前提 |

**v2.0 变更说明**：架构从"重型法规实体层（8+ 张表）"转为"模块增强 AIHOT 事件层（4 张模块表 + documents）"。所有"新落点"已更新：`regulation_families`/`regulations`/`regulation_lineage`/`regulation_review`/`user_capabilities` 等重型表一律替换为 `regulation_tracking`/`regulation_article_links`/`regulation_status_history`/`exclusion_list`/`documents` + `industry/regulation/` 包。实施步骤引用从 S0–S9 改为阶段编号。

**编号约定**：`BR-xx` 与 `01-需求文档.md §6` **一一对应，不得偏移**；正文未列而代码/提示词中确实存在的规则进 `X-xx` 段。若某天 `X-xx` 升格为正文需求，须同步改两边编号并在变更记录里注明。

**路径简写**（均为 WSL 只读）：`<RW>`=`/home/zkye/kfkfka/project/regwatch`，`<RUN>`=`/home/zkye/.hermes/regwatch`，`<PRO>`=`/home/zkye/.hermes/profiles/regpilot`，`<AH>`=`/home/zkye/project/AIHOT`；`cron[早]/[晚]/[周报]/[月]` = `<PRO>/cron/jobs.json` 内同名任务。

> ⚠️ 行号取自 2026-09-24/29 的工作副本，仅供定位，会漂移。**规则文本才是权威**；阶段二实施时对每条重新定位一次，并把定位结果写进对应测试的注释（黄金语料的来源，PLN §6 G6）。

---

## 第一部分：正文 30 条主干规则

### 相关性判定

| 编号 | 规则要点 | 现在写在哪 | 新落点 | 来源事故 |
|---|---|---|---|---|
| **BR-01** | 三层判定（车载 ∧ 含软件 ∧ 我方业务）；"整车安全强标中含软件/电子控制/摄像头/数据记录条款"纳入；九类明确排除 | **`<RW>/parse_llm.py:72`——一句提示词**；复述于 `cron[早]` 步骤 4、`cron[周报]` 步骤 8；`<RUN>/contract.json:146` `materiality_threshold`（定版全文）；`<RW>/skills/devops/regulation-news-monitor/SKILL.md:26` | `industry/prompts/regulation-relevance.md`（词汇）+ `industry/regulation/relevance.ts`（代码闸门，产出三布尔 + `excluded_topic`）+ `exclusion_list(scope='topic')`；**两侧由同一生成器产出防漂移** | **2026-09-07 定版**。此前"电鸣乐器 GB/T 25454""人居环境 GB/T 27963"误落表；根因：`write_parsed_to_base.py:186` 只按阶段过滤，规则无处安放，只能塞进解析提示词 |
| **BR-02** | 只有法规动态落表；行业动态跳过（防污染法规主表） | `<RW>/write_parsed_to_base.py:186-189` + `:26-35`（阶段映射）；`cron[早]` 步骤 4b | `industry/regulation/relevance.ts` 的谓词合取（DES §4.1：**不是分数**）；法规动态写入 `regulation_tracking`，行业动态只留 `articles` | — |

### 生命周期与状态机

| 编号 | 规则要点 | 现在写在哪 | 新落点 | 来源事故 |
|---|---|---|---|---|
| **BR-03** | 六状态只进不退；已修订后再修订仍为已修订（修订日期取最近一次）；已修订→已废止允许 | `<RW>/config/table_schema.json:6-10`（`state_machine.order`、`allow_regression:false`）；强制在 `<RW>/bitable_db.py:221-232`；文字复述在 `cron[早]`/`cron[周报]`"信源表编辑规则 1" | `regulation_tracking.lifecycle_state` CHECK（**取值域**）+ 写路径守卫（**转移**）+ `regulation_status_history`。回退无法用 CHECK 表达，故必须两处分工（DES §4.3）；**不用触发器**（DES §10.3） | 2026-09-03 定版 |
| **BR-04** | 条件必填三条 | `<RW>/config/table_schema.json:11-15`；强制在 `bitate_db.py:234-240`（`op="migrate"` 时放宽） | 写路径守卫在 `industry/regulation/sync.ts` 执行；条件必填由 `LIFECYCLE.conditionalRequired` 声明（DES §4.3） | 同上 |
| **BR-05** | 术语对齐："法规正式发布"事件写作"正式发布"；"法规更新"事件落为"已修订"并必填修订日期；"首个认证发布"→正式发布 | `write_parsed_to_base.py:26-35`（`STAGE_MAP`）；解析侧是**另一套六值枚举**（`parse_llm.py:36`），两者靠 `STAGE_MAP` 桥接 | `industry/regulation/lifecycle.ts` 显式表达为两套枚举 + 一个映射表，不再靠脚本内联字典 | 表格选项名与事件类别名长期不一致的修正 |
| **BR-06** | 日期一律 ISO；实施日期禁自由文本；**官方只有月精度时留空，不填 01 伪造精度** | `<RW>/bitable_db.py:65-82`（`TYPE_GUIDE`，该句原文即在此）；归一在 `parse_llm.py:114-129`（`norm_date`：`2027-1-1`/`2027年1月1日`/`2027.01`，2000–2100 范围守）与 `write_parsed_to_base.py:100-117` | `industry/regulation/identity.ts` 归一模块；`TYPE_GUIDE` 的错误提示文案一并移植（它是给 AI 看的纠错指引，不是给人看的注释） | — |

### 法规族与子项

| 编号 | 规则要点 | 现在写在哪 | 新落点 | 来源事故 |
|---|---|---|---|---|
| **BR-07** | 归族判据一：编号剥离版本标识（年份/Supplement/Rev）后基干相同 ⇒ 同族 | `cron[早]`/`cron[周报]`"信源表编辑规则 2 判据一"（自然语言）；实现散在 `sync_regulations.py:378-415` 的四层匹配索引（全称规范化精确 / 编号精确 / 全称双向子串 / 短键索引） | 确定性匹配器 `industry/regulation/identity.ts` + `regulation_tracking.family_key`；以 `origin='rule'` 记判断（DES V6 证 `analyses.origin` 原生支持） | 2026-09-03 定版 |
| **BR-08** | 归族判据二：官方"代替 XX"⇒ 同族且旧版标已废止并在摘要注明"被 XX 替代"；官方无替代语义（并列发布）⇒ 不同族 | 同上"判据二" | 匹配器在 `identity.ts` 识别官方替代语义 → 写入 `regulation_tracking.family_key`（同族）+ `regulation_status_history(to_state='已废止', origin='rule')`（旧版废止）；**判据是证据，不是启发式**（DES §4.4） | 同上 |
| **BR-09** | NCAP 代际特例：Euro NCAP 2023 与 2026 是并列代际（年份即身份，官方不废止旧代）⇒ **不同族**；代际演进用关联关系表达，不强行归族 | 同上"NCAP 特例"（**纯文字规则，无任何代码分支**） | 匹配器对 NCAP 编号走代际规则：`family_key` 含年份 ⇒ 不同年份不同族（`family_kind='ncap_scheme'` 语义内化于匹配器）。向量分不开此例（DES §4.4 三例算式：三种情形余弦都接近 1.0） | 同上 |
| **BR-10** | 子项/单行本不单独落表；判定为**三态**（确认/不确定/非子项），不确定交人工 | `<RW>/sync_regulations.py:154-206`（`is_subset_record`）：`FAMILY_PREFIXES:117-123`、最长前缀优先 `:128`、**词边界保护**的标记 `:140-151`（仅对规范化编号匹配）、年份先取编号后取全称 `:166`；暂存 `:448-467`；文字在 `cron[*]`"信源表编辑规则 3"与 `<RW>/skills/devops/regwatch-source-sync/SKILL.md:49` | 匹配器三态判定（确认子项/不确定/非子项）写入 `regulation_article_links(relation='part_of')` 桥接；`uncertain` 进评审队列；词边界保护 + 最长前缀优先保留 | **2026-09-04 定版为通用规则**（适用所有法规，非仅 NCAP）。朴素子串匹配曾静默吞并 `VAN`/`TPMS`/`SMART`/`AUTOMATED`；`ASEANCAP` 会被 `ANCAP` 抢先命中 |

### 写入守卫

| 编号 | 规则要点 | 现在写在哪 | 新落点 | 来源事故 |
|---|---|---|---|---|
| **BR-11** | 只补不删：更新只填空字段或修正错值；当前非空且本次无更优值的字段一律不进更新负载 | `cron[早]`"应填尽填铁律"（2026-08-31 review 新增、2026-09-09 定版）；机制支持在 `bitable_db.py` 的 `update` 语义（部分负载免必填校验，`:154-247`） | `industry/regulation/sync.ts` 单事务守卫组；`update` 路径必须保持"部分负载"语义 | **2026-09-09 GB 14166 事件**：一次 enrich 把既有必填字段清空 |
| **BR-12** | 精度不降级：月精度值不得覆盖已精确到日的实施日期；解析失败 ⇒ 保留现值并记"守卫拦截" | `sync_regulations.py:482-492`（守卫 1，`precise_only=true` 分支）+ `:288-289` 注释 | `industry/regulation/identity.ts` 精度守卫；阶段二 2.2 具名断言 `precision_never_downgrades`、`never_blanks_existing` | **UN R79 事件** |
| **BR-13** | 官方链接不被转载页覆盖：`原文链接` 非空时源链接**永不写入**，只产出"待人工确认"；为空时才接受（转载页也比空白强）并同时重推获取方式 | `sync_regulations.py:505-521`（守卫 2）；`:63-73` 注释明确 **`OFFICIAL_DOMAINS` 不作为"可否覆盖"的谓词**、只作报告标签 | `regulation_tracking.origin_locked` 布尔 + 同一守卫；断言 `official_link_never_demoted` | **2026-09-15**：人工修好的 `hbba.sacinfo.org.cn` 官方明细页被源表里一个转载链接静默覆盖。已知代价：真正更好的升级也要人工确认——"宁可多确认，不可静默覆盖" |
| **BR-14** | 零差异即零写入：逐字段比对（排除两个"每天刷新"字段），无差异完全不发起写 | `sync_regulations.py:526-533` + `_norm_field:259-270`（列表拼接、原文链接取内嵌 URL、日期归一） | `regulation_tracking.row_hash`；与平台既有 `IS DISTINCT FROM` 惯用法同源（`<AH>/.../publish.ts:264-279`）；断言 `pending_age_advances_on_noop` | **此前"待评审停留天数恒 0"缺陷**：每天无差异仍写入把时间戳刷成当天 |
| **BR-15** | 应填尽填：新增待评审记录能填的全填（正文列了 18 个字段的清单） | `cron[早]`"应填尽填铁律"；种子逻辑 `sync_regulations.py:588-636`（补齐此前缺失的 7 个必填 + 信源模板 + 认证类型 + 获取方式） | `industry/regulation/sync.ts` 的 seed 路径；必填集进 `lifecycle.ts` | — |
| **BR-16** | 落表即检查：新增/更新时 `上次检查日期`=当天；语义 = 最近一次 T1 原文核验日期 | `write_parsed_to_base.py:227-232`（固定落表值）；语义与**四条写入路径**记录在 `regulation-news-monitor/SKILL.md:23` | `regulation_tracking.last_check_on` + `POST .../check` 端点 | ⚠️ **表里没有"更新日期"这个字段**，只有系统"更新时间"；`cron[*]` 曾按"更新日期=今天"写导致静默失效（2026-09-08 修正）。目标 schema 用英文列名，从根上消除这类混淆 |
| **BR-17** | 黑名单优先且失败即中止：读取排除清单失败 ⇒ 整次流程中止；顺序为先写排除、后删/改记录 | `write_parsed_to_base.py:193-200`（默认 fail-closed，`--alow-blacklist-fail` 才降级）；`sync_regulations.py:333-353`（失败返回 `None` 以**区分"读失败"与"空集合"**）、`:372-374`（`None` 即中止）；`reg_ignore.py:8-113`（先写黑名单再删记录，删除失败仅告警——**黑名单才是生效门**） | `exclusion_list` 唯一写者 + `industry/regulation/exclusion.ts` 读失败即抛；`reg_ignore.py` 在阶段二 2.5 删除（DES §1.3 铁律：只要它活着，"一表一写者"就是空话） | — |
| **BR-18** | 订阅状态受保护：人工置为高频监控/稳定低频后，任何自动 upsert 不得改回 | `<RW>/config/table_schema.json:16-18`（`upsert_preserve`）；实施在 `bitable_db.py:362-369`（**在校验之前**应用） | 进 `industry/regulation/lifecycle.ts` 的 `upsertPreserve`，由 `sync.ts` 守卫执行；投影侧同样遵守（DES §6.4） | — |

### 反幻觉与来源可信

| 编号 | 规则要点 | 现在写在哪 | 新落点 | 来源事故 |
|---|---|---|---|---|
| **BR-19** | 反幻觉三件套：① 提示词铁律（来源 URL 必须原样返回，绝对禁止编造/拼接/猜测）② **代码无条件覆盖** ③ 生成文本实体一致性守卫 | ① `parse_llm.py:77`（铁律原文）与 `:84`（用户消息里再重复一次）② `parse_llm.py:105-106` ③ **无对应**——今天中文摘要只受提示词约束 | ① `industry/prompts/*` ② `articles.url NOT NULL` + 素材层已无条件保证 ③ **直接采用平台既有的实体一致性守卫**（`<AH>/.../editorial/writing.ts:208-231` `enforceIdentity` + `IDENTITY_LEXICON` 正则），为汽车行业重建词典 | `<PRO>/SOUL.md:44` 铁律段明文写"parse_llm.py 已强制覆盖"——第②件早已是机制，第③件是今天完全缺失的一环 |
| **BR-20** | 宁缺毋滥；搜索无结果就如实写"未发现" | `<PRO>/SOUL.md` 铁律；`cron[周报]` 步骤 5 与"未发现项说明"；静态核查 `verify_sources.py:50-82` | 报告组合层的"未发现"分支 + 模板测试（写一行文字，不出空表，见 X-19） | — |
| **BR-21** | **先查自有资产**：解读/问答/review 第一步查本地原文库 + 本地知识库 + 在线知识库，命中即用，绝不重新上网找下载链接 | `<PRO>/SOUL.md:44`（铁律第一条，含被批评的日期标注）；资产清单在 `<PRO>/SOUL.md:52-65` | `documents` 目录与知识层是**同一个库**；FR-05-02 把这条纪律变成一次查询 | **2026-08-27 用户明确批评** |
| **BR-22** | 信源分级与印证：T1 出现即采信（事实基准）；T2 单源标待印证、被 T1 佐证后升级；T3 仅作线索、标需核实、**不单独成文**；徽章 ✅/⏳/⚠️ | `<RUN>/contract.json:5-25`（三级定义 + `cross_verification.rule` + badges）；映射在 `verify_sources.py:50-82`、`write_parsed_to_base.py:203-208`；13 个信源策略模板在 `sync_regulations.py:45-59` | `sources.tier` + `industry/regulation/evidence.ts`（层级→印证状态 + 徽章）。⚠️ **不要移植这个已知 bug**：`sync_regulations.py:593-606` 的类型判定链把所有中国地区记录一律送进 `gb` 模板，导致 C-NCAP/IVISTA/CIASI 记录拿到错误的 T1 信源 | — |

### 表达规范

| 编号 | 规则要点 | 现在写在哪 | 新落点 | 来源事故 |
|---|---|---|---|---|
| **BR-23** | 全文中文；解读引用必须带链接 + 页码 | `<PRO>/SOUL.md`；`cron[*]` 输出要求；`<RW>/skills/research/grounded-citations/SKILL.md`（来源台账 + 引用格式 + grounding 依据） | 平台译文机制 + 引用规范提示词；页码定位由知识层分块 ID 承担（DES §6.2） | — |
| **BR-24** | 禁套话：值得注意的是 / 据悉 / 旨在 / 此外 / 进一步 / 加强完善 | `cron[早]`、`cron[周报]` 明文清单，**无任何强制** | `finalizeCopy` 后置 lint 断言 + 卡片测试用例 | 纪律→机制的典型样本 |
| **BR-25** | 面向读者重写：核心变化写"这条法规本身变了什么、影响是什么"的人话；**禁止**内部管理表述（落表、防污染、订阅状态、印证状态、信源级别、待评审、运行统计、执行报告）；待评审内容一律不进群发正文 | `cron[早]` 步骤 5、`cron[周报]` 步骤 5 与"输出要求"（自然语言）。平台侧**已有成文等价物**：`<AH>/industry/prompts/rules-anti-hallucination.md`（9 条） | **直接采用平台的 9 条规则文件** + 读层字段分离（内部字段与公开投影物理隔离） | 本次移植**成本最低、收益最高**的一处：规则已被上游写好了 |
| **BR-26** | 名称列必须带编号：`[编号 《全称》](URL)`；有编号必须带编号，无编号才只用名称 | `report_helpers.py:81-91`（`_clean_link`）；`cron[*]` 表格列说明 | 报告渲染与门户列表共用同一个链接构造函数 | 2026-09-22 起在名称前拼编号 |
| **BR-27** | 表格单元格内管道符必须转义，否则企业 IM 拆列 | `report_helpers.py:72-79`（`md_table` 逐格转义 + 换行压平）；`xiaobao_card.py:18-33`（**只在链接文本内**转义裸管道符，分隔符不动，且幂等）；测试 `<RW>/tests/test_xiaobao_escape.py` | 阶段二具名断言 | **2026-09-03 实测**：模型偶发在表格单元里写 `[机构\|标题]` |
| **BR-28** | 卡片单一生成器：投递卡片只能由唯一渲染器生成，禁止任何环节手写卡片结构；区块标题须用统一加粗格式以便切分 | `cron[早]`/`cron[周报]`"卡片结构"段（明文禁令）；`xiaobao_card.py:36-69`（`parse_blocks`）、`:72-123`（`build_card`）、`:11-112`（宽度模式仅两值合法，非法值静默回退固定宽度） | RegPilot 的 TS 渲染器 + "单一模块生成"断言 | **三次回归**：2026-08-29 把文件名当文本发出；2026-09-07 井号标题导致整期周报被丢；2026-09-22 表情符号前缀的加粗区块标题被丢且头部被错设 |

### 归档与文件归位

| 编号 | 规则要点 | 现在写在哪 | 新落点 | 来源事故 |
|---|---|---|---|---|
| **BR-29** | 归档契约：原始数据=本地版本库必归档；解析后数据=本地版本库 + 在线知识库必归档；**周报是唯一在线同步项，日报不同步** | `<PRO>/SOUL.md:49`；`archive_daily.py:15-17`（契约原文）与 `:47-85`（约 25 条固定候选路径，**只复制不移动**，缺失只记录不失败）；`cron[*]` 步骤 6/7 | 平台运行留痕 + 对象存储/异地副本（DES §9.5）；在线 wiki 同步保持为投递侧职责 | — |
| **BR-30** | 文件归位：全量导出与工具包→运行数据目录；一次性表导出→其临时子目录；通用报告→输出目录；**禁止散落家目录根** | `<PRO>/SOUL.md:63`（标注"与默认 profile 对齐，2026-09-21 定版"） | 派生仓库 `AGENTS.md` + 对象存储前缀约定 | — |

---

## 第二部分：X 段（正文未列、但同样不能丢）

| 编号 | 规则 | 现在写在哪 | 新落点 / 处置 |
|---|---|---|---|
| **X-01** | 编号缺失**不得**伪装成编号 | ⚠️ 现实现**正是这么做的**：`write_parsed_to_base.py:211` 缺编号时回退 `title[:60]`；`audit_sources.py` 把它列为"疑似全称兜底"脏数据；`bitable_db.py:122-123` 注释明确要求"编号缺失时由调用方决定" | 走合成编号 + `guard_note`，或进"待人工定编号"队列。**存量脏数据来源**，阶段二 2.3 违规报告要专门统计 |
| **X-02** | ISO 特例：前缀是 ISO 但编号不是 `ISO 数字-数字` 形式 ⇒ 判非子项 | `sync_regulations.py:140-206` 内分支 | 同匹配器模块 `industry/regulation/identity.ts`。否则 ISO 9001 会被当成"第 9001 部分" |
| **X-03** | 待确认清单在零待确认时**也不清空**（使积压可被持续处理），按法规编号去重、旧条目优先 | `sync_regulations.py:448-467` | 评审队列 + 保留策略。极易被"顺手改成每次覆盖"破坏，须显式测 |
| **X-04** | 停留天数**在读取时推导**，不得由定时任务写一个"天数"字段 | 语义隐含在 BR-14 的修复里；现无字段 | `regulation_tracking.first_seen_at` + 读时计算（DES §4.6） |
| **X-05** | 认证类型判定链（有优先级 + 具名例外）：NCAP 关键词→新车评价；具例外 UN 编号（166→推荐；79/157/171→如有需符合；182/183→自愿（可选E-mark））须按 `UNR(\d+)`/`ECER(\d+)` 匹配以支持后缀形式；UN/ECE→准入法规（强制）；GBT/GBZ/T339/ISO/TQC/QCT→推荐；Q339/裸 GB/EU(非 ECE)/FMVSS/QC(非 QCT)→强制；TRIAS/ADR/KMVSS→准入法规（强制）；**判不出→待评审** | `<RW>/cert_type.py`（纯函数；`:20-27` 例外表；`_main_` 带 13 例自测） | `industry/regulation/` 下一个表驱动模块 + **移植全部 13 个用例**。"判不出→待评审"这个 fail-safe 方向必须保留 |
| **X-06** | 原文获取方式判定：URL 任意位置以 `.pdf` 结尾（含 markdown 链接与查询串内、大小写不敏感）⇒ PDF 直链；有 URL ⇒ 网页在线；无 ⇒ 暂无原文 | `cert_type.py`（`judge_access_method`）；`write_parsed_to_base.py` 调用 | 同模块 |
| **X-07** | 地区由编号前缀推导（最小适用地区 V2.2）+ 中国检测机构正则兜底；机构由域名推导且**按域名长度降序匹配** | `write_parsed_to_base.py:38-47`（`REGION_MAP`）、`:50-61`、`:88-97`（`:89` 注释说明排序原因：`zxd.catarc.org.cn` 必须先于 `catarc.org.cn`） | `industry/regulation/identity.ts`。长度降序是踩过的 |
| **X-08** | 枚举解析失败的 fail-safe 方向：阶段判不出 ⇒ 默认"行业动态"（即**不落表**）；层级判不出 ⇒ 默认"政策法规"；业务分类**允许空数组**且空数组是合法语义（纯硬件法规不涉及那八个一级分类），交人工复核 | `parse_llm.py:132-186`（`validate_parsed`），`:170` 注释原文 | 同归一模块 + 评审队列。**"默认不污染主表"是正确方向，必须保留** |
| **X-09** | 反爬 ≠ 死链：探活时 403/429 视为"链接可能有效"，不得判坏链 | `verify_sources.py:41-43` | 采集健康度判据 |
| **X-10** | ⚠️ **"来源审查"这一步今天不实际验链接存活**：`check_url` 定义了但主流程从未调用，`main()` 只做静态检查（存在性/协议前缀/层级→印证映射） | `verify_sources.py:50-82` + 全仓引用检索证实无调用点 | **这是既有缺口，迁移时应真正接上**（不是移植一个不工作的函数）。列为阶段一 1.4 附带项 |
| **X-11** | T1 权威源**宁多勿漏**：无关键词白名单的 T1 源全量保留；非 T1 且未命中全局关键词则丢弃；丢弃模式逐条记 `filter_mode` | `fetch_rs.py:83-84`（注释原文"权威源是事实基准，宁多勿漏"）、`:123-138`（三种模式） | 每源 `participation_mode` + `ingestNoiseFilter` + 保留 `filter_mode` 语义（可解释性） |
| **X-12** | 采集失败作为条目流下游（带 `status: fetch_error/parse_error`），不得让单源失败中断整批 | `fetch_rss.py:95,100` | 平台 `fetch_runs` + 信源健康度（退避 `LEAST(interval*(fail_count+2),360)`、连续 5 次标 failing；**预算熔断路不计入失败次数**） |
| **X-13** | 聚类阈值 0.85 的标定依据：同一事件多源实测 0.87–0.97，不同事件 0.34–0.44 | `<RW>/skills/devops/regulation-news-monitor/references/caret-api-notes.md:42-45`；实现 `dedupe_cluster.py:27-28`（阈值 + 48h 窗口） | 在平台聚类机制上用固定语料**重新标定**（DES §7.1：这是唯一建议直接退休替换的组件）；这份标定数据作为对照保留 |
| **X-14** | ⚠️ URL 记忆有界且按**字典序**截断——留下哪 5000 条是字母序巧合，与时间无关 | `dedupe_cluster.py:200`（`sorted(seen)[-500:]`）；另注意此处比对**未做规范化**，与 `fetch_rss.py:68-78`（剥 `#`/`?`）不一致，故状态文件里同时存在拼接过的与干净的同一 URL | 平台身份键 + 发现账本，无"随机遗忘"行为。需求 §9.7 / FR-01-06 的实证依据 |
| **X-15** | 上游"法规基础信息表"为业务方所有：**永不写**；方向是它→法规主表 | `sync_regulations.py:39-42`（源/目标表常量）；`regwatch-source-sync/SKILL.md:28` | 同步与投影的单向性（DES §1.3 铁律 3） |
| **X-16** | 具名脏数据豁免：某韩国 VIN 相关记录因源表名称有误 ⇒ 永不新增也永不更新（否则每天重回待评审） | `sync_regulations.py:421-425`（硬编码排除 + 2026-09-01 确认标注） | `exclusion_list(scope='regulation')` 一条正常数据 + 原因写"源表数据质量问题"，**不再是一段硬编码**。这类豁免极易被当作垃圾代码删掉 |
| **X-17** | 限流处置：429/504 时 sleep 60–120s 重试 ≤3 次；持续失败则**降级解析**（跳过 LLM、用原始标题按模板生成并在头部标注"LLM 解析降级"）；禁止与早/晚/月度任务并行触发 | `cron[周报]` 步骤 3 括注、`cron[早]`"429/504 限流处理"段 | 平台预算熔断（按**尝试**计数）+ P3 全局信号量 + 队列退避；降级路径改为"报告标注数据源不足"而非静默降级 |
| **X-18** | 投递分域：小报正文进群；待评审清单与运行摘要/执行报告**只进单聊**；回填/老资讯永不推送 | `cron[早]`/`cron[周报]`"输出要求"与"重要约定"；`<PRO>/memories/MEMORY.md`（四个任务的投递目标：单聊与小报群两个不同会话，群发用机器人身份） | 平台通知目标按 `purpose` 分域（内容/评审/告警/反馈四路互不串门）+ **目标启用之前的内容永不回填**这条既有不变式，正是"老资讯不推送"的等价物（DES §6.5） |
| **X-19** | 无内容区块写一行"今日无新增动态 ✅"，**不得输出空表格**；区块间用分隔线；倒计时块不得自带小标题（避免双标题） | `cron[早]` 步骤 5、`cron[周报]`；`report_helpers.py:93-118`（空态输出散文行；2026-09-22 移除自带标题） | 报告组合层的空态分支 + 模板测试 |
| **X-20** | 排序不得依赖元组默认比较（同天数会崩） | `report_helpers.py:111`（注释）+ `:93-118` | 显式比较器 |
| **X-21** | 命令行工具约束：文件参数只接受当前目录相对路径（须先 `cd`）；通知抑制环境变量否则重复发送；表格用用户身份、群发用机器人身份；`--text "$(cat …)"` 而非 `@文件` | `<PRO>/SOUL.md:68`；`regulation-news-monitor/SKILL.md`（运行环境铁律）；`bitable_db.py:315-320`（写 `/tmp` 负载再传相对名） | 一处封装；投影优先用平台 API 而非 CLI（DES §6.4） |
| **X-22** | **运行环境铁律**：业务脚本必须用业务虚拟环境的解释器绝对路径调用（系统 `python3` 是框架环境、缺依赖） | `regulation-news-monitor/SKILL.md`（明文铁律）；`<RUN>/contract.json:crawl_env.venv` | DES §9.2：架构上消除（平台容器零 Python、跨界只走 HTTP、`doctor` 在部署期失败）。**2026-09-29 早间任务当前 error 即此因** |

---

## 第三部分：字段质量判据（来自已停用的审计脚本，但它是最好的成文规范）

`<RW>/audit_sources.py` 头部标注"⚠️ 已停用 2026-09-02"，其一次性用途（读 `/tmp` 里两个快照）也确实作废。但它列出的检查项是**字段质量最好的成文定义**，迁移时逐条变成校验器规则：

1. 13 个必填字段齐全；
2. 生命周期阶段属于合法枚举；
3. 实施日期 ≥ 发布日期；
4. 状态为征求意见稿 ⇒ 征求意见截止日期存在；
5. 日期格式符合正则；
6. 编号长度 > 80 ⇒ 判"疑似全称兜底"（见 X-01）；
7. 发布机构为"其他"或空 ⇒ 需人工确认；
8. 地区属于合法枚举；
9. 摘要 / 影响评估 < 10 字 ⇒ 判过短；
10. 信源 T1 合理性（域名像不像官方）；
11. **存量导入逐格 diff**——这一条在 Bitable→Postgres 迁移里同样需要，形式上就是阶段二 2.3 判据②"逐格 diff"。

**处置**：把这份清单移植为 `industry/regulation/quality.ts` 的规则表 + 阶段二 2.3 的导入报告项；脚本本身不移植。

---

## 第四部分：覆盖度自检

| 检查 | 结果 |
|---|---|
| `REG-REQ-01 §6` 的 BR-01 … BR-30 是否逐条出现且编号一致 | **是**，30 条全部对齐，无偏移 |
| 每条是否有"现在写在哪"与"新落点" | 是。BR/X 全表无空格 |
| 是否存在"新落点"仍指向自然语言规则（即本次未成机制） | 一处需留意：BR-01/BR-25 的规则**文本**仍在提示词里（这是正确的：Taste 类规则该活在提示词里且带版本哈希），但其**判决与留痕**已变为机制。DES §4.3、§7.5 说明了这条边界 |
| 已知不移植项是否具名 | 三条：BR-22 的中国记录模板选择 bug；X-10 的"探活函数从未被调用"（改为真正接上）；X-14 的字典序截断（改为不随机遗忘） |
| 建议**故意偏离**现状项是否具名 | 一条（需求 O-3）：`暂不关注` 不再物理删除记录（DES §4.5）。旧行为在本表 BR-17 的"现在写在哪"列可查 |
| v2.0 新落点是否全部指向轻量模块表 | **是**。`regulation_tracking`（20 列）+ `regulation_article_links` + `regulation_status_history` + `exclusion_list` + `documents`，无 `regulation_families`/`regulations`(21+26)/`regulation_lineage`/`regulation_review`/`user_capabilities` |

### 未覆盖声明（诚实标注）

1. **权威 PRD 未能在本次调研中读取**（它在企业 IM 文档中，模块 01–05 的定义文档）。本表全部"现在写在哪"来自本地镜像：`<RW>/docs/`、`<RW>/skills/`、`<PRO>/SOUL.md`、`<RUN>/contract.json`、`cron/jobs.json`。若 PRD 与本表有出入，以 PRD 为准并回写需求变更记录（需求 §11 A7、§12 O-1）。
2. **若干规则只存在于提示词的自然语言里、无代码强制**：BR-24 禁套话、BR-25 面向读者重写、X-17 限流处置、BR-09 的 NCAP 代际例外。它们在"现在写在哪"列指向 `cron[*]`，语义是**纪律而非机制**。本次重构的主要收益之一正是把它们变成机制。
3. 行号会漂移，规则文本不会。以文本为准。

### 阶段二出口条件

本表每一行的"新落点"列，要么指向已存在的实现，要么显式标注"本次不承载 + 原因"。**不允许留空。** 这是 PLN §6 全局规则 G1 能被执行的验证方式。
