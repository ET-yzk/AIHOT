# Issue 跟踪器：GitHub

本仓库的 issue 和规格都放在 GitHub Issues 里，位置是 `ET-yzk/AIHOT`（本仓库的 fork），不是上游 `KKKKhazix/AIHOT`。所有操作使用 `gh` CLI。

## 指定仓库

本仓库有两个远程：`origin`（`ET-yzk/AIHOT`）和 `upstream`（`KKKKhazix/AIHOT`），`gh` 无法自动判断该用哪个。新克隆后先执行 `gh repo set-default origin`，或在命令里显式加 `-R ET-yzk/AIHOT`。

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读取 issue**：`gh issue view <number> --json number,title,body,labels,comments`。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配合 `--label`、`--state` 过滤。
- **把 issue 设为父 issue 的子 issue**：`gh issue create --parent <parent> ...`，或事后 `gh issue edit <parent> --add-sub-issue <child>`（`gh` 2.94+）。旧版 `gh`：`gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`（数据库 id，见下面的**阻塞**）。不支持子 issue 时，在子 issue 正文顶部写 `Part of #<parent>`。
- **阻塞**：GitHub 原生 issue 依赖，界面上可见的标准表示。加边用 `gh issue create --blocked-by <n>,<n> ...` 或 `gh issue edit <child> --add-blocked-by <blocker>`（`gh` 2.94+）。旧版 `gh`：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞方 issue 的数字**数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，不是 `#number`，也不是 `node_id`）。不可用时退化为在子 issue 正文顶部写 `Blocked by: #<n>, #<n>`。所有阻塞方都关闭时，该 ticket 才算解锁。
- **统计未关闭的阻塞方**：`gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by`（只算未关闭的；0 表示可以开工）。`gh issue view <n> --json blockedBy` 也会列出已关闭的阻塞方，需要过滤：`--jq '[.blockedBy.nodes[] | select(.state == "OPEN")] | length'`。
- **评论**：`gh issue comment <number> --body "..."`
- **加/删标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：先用 `gh issue comment <number> --body "..."` 说明，再 `gh issue close <number>`。对已关闭的 issue 执行 `gh issue close --comment` 会丢掉评论但仍退出 0。

## 只往自己的仓库提

只往 `ET-yzk/AIHOT` 建 issue。不要往上游 `KKKKhazix/AIHOT` 建，除非使用者明确要求。

## PR 是否作为 triage 入口

**PRs as a request surface: no.**（若本仓库把外部 PR 当作功能请求，改成 `yes`；`/triage` 会读这个标记。）

设为 `yes` 时，PR 走与 issue 相同的标签和状态，使用对应的 `gh pr` 命令：

- **读取 PR**：`gh pr view <number>`，然后 `gh pr view <number> --comments`（非 TTY 下 `--comments` 只打印评论，不含正文），diff 用 `gh pr diff <number>`。
- **列出待 triage 的外部 PR**：`gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`。
- **评论 / 打标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 和 PR 共用一套编号，所以裸 `#42` 可能是两者之一：先 `gh pr view 42`，失败再 `gh issue view 42`。

## 当某个 skill 说“发布到 issue tracker”

创建 GitHub issue。

## 当某个 skill 说“取出对应的 ticket”

按上面的**读取 issue**读取。

## Wayfinding 操作（`/wayfinder` 使用）

**地图**是单个 issue，**子 ticket** 是它的子 issue。

- **地图**：一个带 `wayfinder:map` 标签的 issue，正文放 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **子 ticket**：作为地图的 GitHub 子 issue 关联（见上文的子 issue 用法）。不支持子 issue 时，把子 issue 加进地图正文的任务列表，并在子 issue 正文顶部写 `Part of #<map>`。标签：`wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。认领后指派给执行者。
- **阻塞**：见**约定**里的“阻塞”。
- **找前沿**：列出地图下未关闭的子 issue，去掉有未关闭阻塞方（见“统计未关闭的阻塞方”，或正文里未关闭的 `Blocked by` 行）或已有 assignee 的；按地图顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`，这是本次会话的第一次写操作。
- **完成**：`gh issue comment <n> --body "<答案>"`，然后 `gh issue close <n>`，再把上下文指针（要点 + 链接）追加到地图的 Decisions-so-far。
