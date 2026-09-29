// 车载行业的分类体系：业务分类、内容类型、标签词表、机构与整车厂名录，以及防止张冠李戴的身份词典。
// 模型按这里的词表打标签，主题页（topics.json）按标签归类，筛选栏按类别分组。
// 换行业时：类别的 key 会出现在网址里（/all?category=…），上线后就不要再改；标签和名录可以随时增减。

/**
 * 网页上的类别（筛选栏、卡片角标、RSS 分类订阅）。key 是网址和接口里的身份，上线后不要改。
 * section 是日报里的分节标题（几个类别可以共用一节，按这里的顺序排）；guide 告诉模型怎么归类。
 * 没有 key 为 industry 的类别，所以没归上类的资料进日报的最后一节（「行业动态」）。
 *
 * 「法律法规」与「行业标准」两类合起来是读者筛选栏里的法规开关（FR-02-02），热点排序的法规加权
 * 按这两个 key 生效（industry/selection.ts 的 REGULATION_CATEGORIES），改 key 要同步改那里。
 */
export const CATEGORIES = [
  {
    key: "regulation",
    label: "法律法规",
    section: "法规与标准",
    guide: "规范性文件本身的变化：征求意见稿、报批稿、正式发布、实施、修订与废止。范围是道路机动车的整车、系统、零部件、软件与试验方法中的强制性与准入类法规，包括联合国 UN/WP.29 法规、欧盟法规和中国强制性国家标准（GB），以及整车安全类标准中含软件、电子控制、摄像头或数据记录条款的部分",
  },
  {
    key: "standard",
    label: "行业标准",
    section: "法规与标准",
    guide: "推荐性国家标准、行业标准、团体标准，以及 NCAP 测评规程与试验方法文本本身的发布和换版；不新增强制义务，但带来新的测评要求",
  },
  {
    key: "vehicle",
    label: "新车发布",
    section: "新车与技术",
    guide: "新车型、改款与配置的发布和上市，尤其是搭载驾驶员监测、乘员监测、座舱感知与 ADAS 视觉感知的车型，以及公告目录里出现的新功能配置",
  },
  {
    key: "technology",
    label: "技术落地",
    section: "新车与技术",
    guide: "车载传感器、芯片、算法与软件的量产落地、定点与合作、技术路线变化，以及承载这些功能的软件与数据架构",
  },
  {
    key: "ncap",
    label: "NCAP 评测",
    section: "测评与认证",
    guide: "C-NCAP、Euro NCAP、IVISTA 等测评的结果发布：星级、得分与具体测试项表现，以及测评方法变化对功能设计提出的新要求",
  },
  {
    key: "customer",
    label: "客户动态",
    section: "行业动态",
    guide: "整车厂与零部件伙伴的公司动态：技术合作、组织与战略调整、融资并购、销量与市场、诉讼与召回",
  },
] as const;

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score.md）按类型给五个维度不同的权重。
 */
export const ITEM_TYPES = [
  "regulation_proposal", "regulation_release", "regulation_change", "standard_revision",
  "vehicle_launch", "technology_adoption", "ncap_result", "industry_event", "opinion_analysis",
] as const;

// ── 标签词表 ────────────────────────────────────────────────────────────────────────────

/** 每篇资料的第一个标签必须是这些“分类标签”之一。 */
export const CATEGORY_TAGS = [
  "法规动态", "标准动态", "测评结果", "新车发布", "技术落地", "客户动态",
  "政策/监管", "合规/认证", "安全/隐私", "观点/分析", "教程/实践", "其他",
] as const;

/** 可选的主题标签（算法与功能方向）。 */
export const TOPIC_TAGS = [
  "DMS", "OMS", "座舱感知", "ADAS 视觉感知", "车载数据安全", "隐私合规", "功能安全",
  "SOTIF", "OTA 升级", "数据记录", "传感器与芯片", "智能座舱", "网联通信", "试验方法", "准入认证",
] as const;

/** 可选的实体标签（机构、整车厂、供应商）。 */
export const ENTITY_TAGS = [
  "工信部", "公安部", "市场监管总局", "UN/WP.29", "欧盟", "C-NCAP", "Euro NCAP", "中汽中心",
  "比亚迪", "吉利", "长安", "蔚来", "小鹏", "理想", "华为", "博世", "大陆集团", "Mobileye", "高通", "NVIDIA",
] as const;

/** 模型常写的近义词，统一成词表里的写法。 */
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  法规: "法规动态", 监管: "法规动态", 政策: "政策/监管", 公告: "法规动态", 征求意见: "法规动态",
  标准: "标准动态", 行标: "标准动态", 团标: "标准动态", 规程: "标准动态",
  ncap: "测评结果", 测评: "测评结果", 评测: "测评结果", 星级: "测评结果",
  新车: "新车发布", 上市: "新车发布", 车型: "新车发布", 改款: "新车发布",
  技术: "技术落地", 量产: "技术落地", 定点: "技术落地", 芯片: "传感器与芯片", 传感器: "传感器与芯片",
  客户: "客户动态", 公司: "客户动态", 合作: "客户动态", 融资: "客户动态", 收购: "客户动态", 并购: "客户动态",
  合规: "合规/认证", 认证: "合规/认证", 准入: "合规/认证",
  安全: "安全/隐私", 隐私: "安全/隐私", 数据合规: "车载数据安全",
  驾驶员监测: "DMS", 疲劳驾驶: "DMS", 分心驾驶: "DMS", 乘员监测: "OMS", 舱内感知: "座舱感知",
  自动驾驶: "ADAS 视觉感知", 辅助驾驶: "ADAS 视觉感知", 智驾: "ADAS 视觉感知",
  观点: "观点/分析", 评论: "观点/分析", 分析: "观点/分析", 趋势: "观点/分析",
  教程: "教程/实践", 实践: "教程/实践", 指南: "教程/实践",
};

/** 模型漏了分类标签时，按内容类型补一个。 */
export const CATEGORY_BY_ITEM_TYPE: Readonly<Record<string, string>> = {
  regulation_proposal: "法规动态", regulation_release: "法规动态", regulation_change: "法规动态",
  standard_revision: "标准动态", vehicle_launch: "新车发布", technology_adoption: "技术落地",
  ncap_result: "测评结果", industry_event: "客户动态", opinion_analysis: "观点/分析",
};

/**
 * 公开出口（API v1、RSS、MCP）怎么读分类：按对外 key 查询时，还要把列在这里的其它内部 key 一起算进来。
 * 上游用它把「观点」并进「教程」，好让读者少一个入口。这里内部分类与对外分类一一对应，所以是空的；
 * 真要折叠就写 `{ 对外key: ["内部key", …] }`。
 */
export const PUBLIC_CATEGORY_FOLDS: Readonly<Record<string, readonly string[]>> = {};

// ── 机构与主体 ──────────────────────────────────────────────────────────────────────────

/** 机构与整车厂主题：id → 显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。 */
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[] }> = {
  miit: { name: "工业和信息化部", displayTag: "工信部", aliases: ["工信部", "MIIT", "工业和信息化部", "装备工业一司"] },
  "samr-sac": { name: "市场监管总局 / 国标委", displayTag: "市场监管总局", aliases: ["市场监管总局", "SAMR", "国家标准委", "国标委", "SAC"] },
  mps: { name: "公安部", displayTag: "公安部", aliases: ["公安部", "交管局"] },
  unece: { name: "联合国 WP.29", displayTag: "UN/WP.29", aliases: ["WP.29", "UNECE", "联合国欧洲经济委员会", "GRVA", "GRVP"] },
  eu: { name: "欧盟", displayTag: "欧盟", aliases: ["欧盟", "European Commission", "EUR-Lex", "GSR"] },
  "c-ncap": { name: "C-NCAP / 中汽研", displayTag: "C-NCAP", aliases: ["C-NCAP", "中国保险汽车安全指数", "中保研", "IVISTA", "中国汽研"] },
  "euro-ncap": { name: "Euro NCAP", displayTag: "Euro NCAP", aliases: ["Euro NCAP", "欧洲新车评价规程"] },
  catarc: { name: "中汽中心", displayTag: "中汽中心", aliases: ["中汽中心", "CATARC", "中国汽车技术研究中心"] },
  byd: { name: "比亚迪", displayTag: "比亚迪", aliases: ["比亚迪", "BYD", "腾势", "仰望"] },
  geely: { name: "吉利", displayTag: "吉利", aliases: ["吉利", "Geely", "极氪", "领克", "沃尔沃"] },
  changan: { name: "长安汽车", displayTag: "长安", aliases: ["长安", "长安汽车", "深蓝", "阿维塔"] },
  nio: { name: "蔚来", displayTag: "蔚来", aliases: ["蔚来", "NIO", "乐道"] },
  xpeng: { name: "小鹏汽车", displayTag: "小鹏", aliases: ["小鹏", "XPeng"] },
  li: { name: "理想汽车", displayTag: "理想", aliases: ["理想", "Li Auto", "理想汽车"] },
  huawei: { name: "华为", displayTag: "华为", aliases: ["华为", "Huawei", "鸿蒙智行", "乾崑", "MDC"] },
  bosch: { name: "博世", displayTag: "博世", aliases: ["博世", "Bosch"] },
  continental: { name: "大陆集团", displayTag: "大陆集团", aliases: ["大陆集团", "Continental"] },
  mobileye: { name: "Mobileye", displayTag: "Mobileye", aliases: ["Mobileye", "EyeQ"] },
  qualcomm: { name: "高通", displayTag: null, aliases: ["高通", "Qualcomm", "骁龙"] },
  nvidia: { name: "NVIDIA", displayTag: null, aliases: ["NVIDIA", "英伟达", "Orin", "Thor"] },
};

/**
 * 身份词典：摘要和标题里出现的机构或整车厂，必须在原文里也出现过，否则退回原标题、丢掉摘要（防止模型张冠李戴）。
 * 法规报道最容易把发布机构写错（工信部发布的通知被写成市场监管总局发布），这一层是硬约束。
 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "miit", name: "工业和信息化部", patterns: [/工信部|miit|工业和信息化部|装备工业/i] },
  { id: "samr-sac", name: "市场监管总局 / 国标委", patterns: [/市场监管总局|samr|国标委|国家标准委|全国标准信息公共服务平台|\bsac\b/i] },
  { id: "mps", name: "公安部", patterns: [/公安部|交通管理局|交管局/i] },
  { id: "unece", name: "联合国 WP.29", patterns: [/wp\.?29|unece|联合国欧洲经济委员会|grva|grvp/i] },
  { id: "eu", name: "欧盟", patterns: [/欧盟|european\s?(commission|parliament|council)|eur-?lex|\bgsr\b|regulation\s*\(ec\)/i] },
  { id: "c-ncap", name: "C-NCAP / 中汽研", patterns: [/c-?ncap|中保研|ivista|中国保险汽车安全指数|中国汽研/i] },
  { id: "euro-ncap", name: "Euro NCAP", patterns: [/euro\s?ncap|欧洲新车评价规程/i] },
  { id: "catarc", name: "中汽中心", patterns: [/中汽中心|catarc|中国汽车技术研究中心/i] },
  { id: "byd", name: "比亚迪", patterns: [/比亚迪|\bbyd\b|腾势|仰望/i] },
  { id: "geely", name: "吉利", patterns: [/吉利|\bgeely\b|极氪|领克|\bzeekr\b/i] },
  { id: "changan", name: "长安汽车", patterns: [/长安汽车|\bchangan\b|深蓝汽车|阿维塔/i] },
  { id: "nio", name: "蔚来", patterns: [/蔚来|\bnio\b|乐道/i] },
  { id: "xpeng", name: "小鹏汽车", patterns: [/小鹏|\bxpeng\b/i] },
  { id: "li", name: "理想汽车", patterns: [/理想汽车|\bli\s?auto\b/i] },
  { id: "huawei", name: "华为", patterns: [/华为|huawei|鸿蒙智行|乾崑|\bmdc\b/i] },
  { id: "bosch", name: "博世", patterns: [/博世|\bbosch\b/i] },
  { id: "mobileye", name: "Mobileye", patterns: [/mobileye|\beyeq\b/i] },
  { id: "nvidia", name: "NVIDIA", patterns: [/nvidia|英伟达|\borin\b|\bthor\b/i] },
];

/** 这些域名上的文章，发布方就是对应的机构（托管平台不算）。 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "miit", domains: ["miit.gov.cn"] },
  { entityId: "samr-sac", domains: ["samr.gov.cn", "std.samr.gov.cn", "openstd.samr.gov.cn"] },
  { entityId: "unece", domains: ["unece.org"] },
  { entityId: "eu", domains: ["eur-lex.europa.eu", "ec.europa.eu"] },
  { entityId: "c-ncap", domains: ["cncap.org.cn", "caam.cn"] },
  { entityId: "euro-ncap", domains: ["euroncap.com"] },
  { entityId: "catarc", domains: ["catarc.ac.cn"] },
];

/** 原文里的这些写法也算提到了对应机构。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [
  { entityId: "samr-sac", pattern: /SAC\/TC\b|\bGB\s?\/?\s?T?\s?\d{3,}/i },
  { entityId: "unece", pattern: /\bECE\s?R\d|\bUN\s?R\d|\bNo\.\s?\d{3}\s?Rev/i },
];
