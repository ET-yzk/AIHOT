# 领域文档

工程类 skill 探索本仓库时，按这里的规则消费领域文档。

## 探索之前先读

- 根目录的 **`GLOSSARY.md`**，或
- 根目录的 **`GLOSSARY-MAP.md`**（如果存在）：它指向每个上下文各一份 `GLOSSARY.md`，读与当前话题相关的那些。
- **`docs/adr/`**：读与你即将改动的区域相关的 ADR。多上下文仓库还要看 `src/<context>/docs/adr/` 里的上下文级决策。

这些文件不存在就**静默跳过**：不要指出缺失，也不要主动建议创建。等术语或决策真正定下来时，`/domain-modeling` skill（经 `/grill-with-docs` 与 `/improve-codebase-architecture` 到达）会按需创建。

## 文件结构

本仓库是单上下文：

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文仓库（根目录有 `GLOSSARY-MAP.md`）：

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← 系统级决策
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← 上下文级决策
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

## 用词表里的词汇

当输出里要提到某个领域概念（issue 标题、重构提案、假设、测试名），使用 `GLOSSARY.md` 定义的说法，不要漂移到词表明确回避的同义词。

如果需要的概念还没进词表，这是个信号：要么你在发明项目不用的语言（重新考虑），要么确实有缺口（记下来交给 `/domain-modeling`）。

## 标出与 ADR 的冲突

如果你的输出与现有 ADR 矛盾，明确指出来，不要悄悄覆盖：

> _与 ADR-0007（event-sourced orders）冲突，但值得重开讨论，因为……_
