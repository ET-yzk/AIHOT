// 金标与门槛校准：在这里逐条判定「这条该不该进精选」，判定落进 gold_labels，
// 页面同时给出「今天库里的分数与你标的差多少」，并把同一批行导出成 scripts/eval-selection.ts 能直接读的样子。
// 页面不调用模型：付费的新鲜评测仍然只有那一条命令，安全阀开着才跑。
import { useState } from "react";
import { useNavigate } from "react-router";
import { SITE } from "@aihot/site";
import type { Route } from "./+types/gold";
import type { AdminGoldBoard, AdminGoldCase, AdminGoldReport, AdminGoldView } from "@aihot/contracts/admin";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj, num, pct } from "../../features/admin/format";
import { AdminPage, Badge, Button, ButtonLink, Card, DataTable, Empty, Stat, Textarea } from "../../features/admin/ui";

const DECISIONS = [
  { value: "select", label: "该进精选", why: "这条今天就该被读者看到，值得占一个精选的位置" },
  { value: "reject", label: "不该进", why: "写得再长也不该占位置：例行播报、与读者无关、只有传闻" },
  { value: "either", label: "两可", why: "进不进都讲得通；它不计入准确率，只用来标出边界在哪" },
];

/** Where a band sits against its own tier's bar, in the words the sampling uses. */
const BANDS: Record<AdminGoldCase["band"], string> = {
  "near-below": "门槛下面一点（−12～0）：门槛下调就会选上",
  "near-above": "门槛上面一点（0～+8）：门槛上调就会掉出去",
  "far-above": "远高于门槛",
  "far-below": "远低于门槛",
  block: "预筛就拦下了，没有打分",
  unscored: "没有分数（新收录或只有一条来源）",
};

export async function loader({ request }: Route.LoaderArgs) {
  const seed = Number(new URL(request.url).searchParams.get("seed")) || 7;
  const view = await adminGet<AdminGoldView>(request, `/api/admin/gold?seed=${seed}`);
  return { ...view, seed };
}

export const meta: Route.MetaFunction = () => [{ title: `金标与门槛校准 · ${SITE.name} 后台` }];

export default function Gold({ loaderData }: Route.ComponentProps) {
  const { board, report, seed } = loaderData;
  return (
    <AdminPage
      title="金标与门槛校准"
      subtitle="逐条写下你的判定，作为评分标准与门槛的对照。判定存进库里，导出就是 scripts/eval-selection.ts 能直接读的那张表；这一页不调用模型，比的是库里已有的分数。"
      actions={
        <>
          <a
            href="/api/admin/gold/sheet"
            className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-control bg-surface px-3.5 text-[13.5px] font-medium text-ink ring-1 ring-line-strong transition-[opacity,background-color] hover:bg-bg-sunk"
          >
            导出金标表（{report.labelled} 条）
          </a>
          <ButtonLink to={`/admin/gold?seed=${seed + 1}`}>换一批待标</ButtonLink>
        </>
      }
    >
      <div className="space-y-6">
        <Rubric board={board} />
        <Agreement report={report} />
        <Awaiting board={board} />
        <Labelled labels={board.labels} />
        <Mistakes report={report} />
      </div>
    </AdminPage>
  );
}

/** 细则说明：三态各怎么给、按什么给，以及标准本身写在哪里。 */
function Rubric({ board }: { board: AdminGoldBoard }) {
  return (
    <Card title="标注细则" right={<Badge tone="muted">评分提示词 {board.promptVersion.slice(0, 8)}</Badge>}>
      <div className="space-y-3 text-sm">
        <ul className="space-y-1.5">
          {DECISIONS.map((d) => (
            <li key={d.value}>
              <b>{d.label}</b>
              <span className="font-mono text-[12px] text-ink-4"> {d.value} </span>
              ——{d.why}
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground">
          按<b>这条资料本身</b>该不该选来标，不要因为同一件事已经选过另一篇就标 reject：这里校准的是入选判断，不含归组去重。
          先只看中文标题和原文自己判，判完再展开「模型怎么说」，免得被它的说法带着走。
        </p>
        <div className="flex flex-wrap gap-2">
          {Object.entries(board.thresholds).map(([tier, value]) => (
            <Badge key={tier} tone="muted" title="两次独立评分的平均值到门槛才成为精选候选">{tier} 门槛 {value}</Badge>
          ))}
          <Badge tone="muted">待标 {board.waiting} 条</Badge>
          <Badge tone="muted">已标 {board.labelled} 条</Badge>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {board.bands.filter((b) => b.waiting).map((b) => (
            <span key={b.band} title={BANDS[b.band]}>{b.band} {b.waiting} 条</span>
          ))}
        </div>
        <p className="text-muted-foreground">
          五个维度与权重写在 <code>industry/prompts/selection-score.md</code>，门槛数字写在 <code>industry/selection.ts</code>。
          顺序是<b>先改标准，再动门槛</b>：错误集中在门槛附近才考虑改数字，改了要用这张标注重跑
          <code> node --env-file=.env scripts/eval-selection.ts --gold &lt;导出的文件&gt; --split development</code>（流程见 docs/selection.md）。
          留验（holdout）那三分之一不参与调提示词，只看它是否也涨。
        </p>
      </div>
    </Card>
  );
}

function Agreement({ report }: { report: AdminGoldReport }) {
  const m = report.metrics;
  if (!report.labelled) {
    return <Card title="今天的一致程度"><Empty>还没有标注。标几条以后，这里会给出模型判定与你的判定差在哪，以及每档门槛挪动的后果。</Empty></Card>;
  }
  return (
    <Card title="今天的一致程度" right={<Badge tone="muted">用库里已有的分数算，不重跑模型</Badge>}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="准确率" value={pct(m.accuracy)} hint={`判得清的 ${m.decisive} 条` } />
        <Stat label="完整准确率" value={pct(m.completeAccuracy)} hint={`没答上的也算错，分母 ${m.decisiveGold}`} />
        <Stat label="查准率" value={pct(m.precision)} hint="它选出来的里面你认可多少" tone={m.precision < 0.8 ? "warn" : "ok"} />
        <Stat label="查全率" value={pct(m.recall)} hint="你认为该选的它漏了多少" tone={m.recall < 0.8 ? "warn" : "ok"} />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>F1 {num(m.f1, 3)}</span><span>·</span>
        <span>覆盖率 {pct(m.coverage)}</span><span>·</span>
        <span>它选了 {pct(m.selectedRate)}，你认可 {pct(m.goldSelectRate)}</span><span>·</span>
        <span>多选 {m.fp} · 漏了 {m.fn} · 判错之前没答上 {m.decisiveErrors}</span><span>·</span>
        <span>两可 {m.either} 条不计入</span>
      </div>
      <Sweeps report={report} />
    </Card>
  );
}

/** Per tier: the same bar swept ±6, because a T1 item and a T2 item are not judged by one number. */
function Sweeps({ report }: { report: AdminGoldReport }) {
  const withData = report.sweeps.filter((s) => s.rows.length);
  if (!withData.length) return null;
  return (
    <div className="mt-4 space-y-4">
      {withData.map((s) => {
        const best = [...s.rows].sort((a, b) => b.F1 - a.F1)[0]!;
        return (
          <div key={s.tier}>
            <div className="mb-1 text-xs font-medium">
              {s.tier} · 现在 {s.current} · 这批样本里 F1 最高在 {best.t}
              <span className="ml-2 font-normal text-muted-foreground">（{s.rows[0]!.decisiveGold} 条标过的资料，样本少时这条线只是方向）</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {s.rows.map((row) => (
                <span
                  key={row.t}
                  title={`准确率 ${pct(row.acc)} · 查准 ${pct(row.P)} · 查全 ${pct(row.R)} · 它选 ${pct(row.sel)}`}
                  className={`num rounded px-2 py-1 text-xs tabular-nums ${row.t === s.current ? "bg-accent-soft font-semibold text-accent" : "bg-bg-sunk text-ink-3"}`}
                >
                  {row.t} {pct(row.acc, 0)}
                </span>
              ))}
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        扫的每一个门槛下，预筛拦下的那条都算「没选上」，所以这条线与你上面的数字是同一批分母。
        库里存的是两次评分的平均值（下取整），所以这里扫出来的线与真实判定可能差半分——那半分不改变结论。
        要拿它改 <code>industry/selection.ts</code> 里的数字，先用导出的金标表跑一次真实评测。
      </p>
    </div>
  );
}

function Awaiting({ board }: { board: AdminGoldBoard }) {
  return (
    <Card title="待标" right={<Badge tone="muted">{board.cases.length} 条 · 按离门槛的远近抽的</Badge>}>
      {board.cases.length ? (
        <div className="space-y-3">
          {board.cases.map((c) => <Judgement key={c.caseId} c={c} />)}
        </div>
      ) : <Empty>这一批都标完了。点「换一批待标」接着标。</Empty>}
    </Card>
  );
}

/** One item: its own text first, the model's verdict only after you have committed to yours. */
function Judgement({ c }: { c: AdminGoldCase }) {
  const { run, pending } = useAdminAction();
  const [reveal, setReveal] = useState(false);
  const [note, setNote] = useState("");
  const decided = c.decision !== null;
  const save = async (decision: string) => {
    const ok = await run("POST", `/api/admin/gold/${c.caseId}`, { decision, note: note || undefined, split: c.split }, { label: `${c.caseId}:${decision}`, success: `已记为 ${decision}` });
    if (ok) setReveal(true);
  };
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">{c.titleZh || c.title}</div>
          {c.titleZh && <div className="mt-0.5 truncate text-xs text-muted-foreground">{c.title}</div>}
          <div className="mt-0.5 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{c.sourceName} · {c.sourceTier} · {c.sourceKind}</span>
            {c.publishedAt && <span>{bj(c.publishedAt)}</span>}
            <span title={BANDS[c.band]}>{c.band}</span>
            {c.split === "holdout" && <Badge tone="muted" title="不参与调提示词，只用来看改完是否也涨">留验</Badge>}
          </div>
        </div>
        <a className="text-xs underline" href={c.url} target="_blank" rel="noreferrer">原文页</a>
      </div>
      {c.judged && (
        <details className="mt-2" open={!c.titleZh}>
          <summary className="cursor-pointer text-xs text-muted-foreground">{c.judged.length} 字原文</summary>
          <p className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap text-xs leading-relaxed">{c.judged}</p>
        </details>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {DECISIONS.map((d) => (
          <Button key={d.value} size="sm" tone={decided && c.decision === d.value ? "primary" : "secondary"} busy={pending === `${c.caseId}:${d.value}`} onClick={() => void save(d.value)}>{d.label}</Button>
        ))}
        <Textarea rows={1} className="min-w-40 flex-1" placeholder="为什么（可选，会一起存进审计）" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {(c.score !== null || c.reasonZh || c.relevance === "block") && (
        <details className="mt-2" open={reveal}>
          <summary className="cursor-pointer text-xs text-muted-foreground">模型怎么说</summary>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={c.modelSelected ? "ok" : "muted"} title="库里存的判定">它选了吗：{c.modelSelected === null ? "没答上" : c.modelSelected ? "选了" : "没选"}</Badge>
            <span>平均分 {c.score ?? "—"} / 门槛 {c.threshold ?? "—"}</span>
            {c.relevance === "block" && <Badge tone="bad">预筛就拦下</Badge>}
            {c.model && <span className="text-muted-foreground">{c.model}</span>}
            {c.reasonZh && <span className="text-muted-foreground">{c.reasonZh}</span>}
          </div>
        </details>
      )}
    </div>
  );
}

function Labelled({ labels }: { labels: AdminGoldCase[] }) {
  const { run, pending } = useAdminAction();
  if (!labels.length) return null;
  return (
    <Card title="已标注" right={<Badge tone="muted">{labels.length} 条</Badge>} pad={false}>
      <DataTable
        rows={labels}
        rowKey={(r) => r.caseId}
        empty="还没有标注"
        columns={[
          { key: "t", label: "标题", render: (r) => <span className="block max-w-96 truncate">{r.titleZh || r.title}</span> },
          { key: "b", label: "分数段", render: (r) => <span className="whitespace-nowrap text-xs" title={BANDS[r.band]}>{r.sourceTier} · {r.band}</span> },
          {
            key: "d",
            label: "你的判定",
            render: (r) => (
              <span className="flex items-center gap-1 whitespace-nowrap">
                <Badge tone={r.decision === "select" ? "ok" : r.decision === "reject" ? "bad" : "muted"}>{r.decision}</Badge>
                {r.split === "holdout" && <span className="text-xs text-ink-4">留验</span>}
                {r.note && <span className="max-w-40 truncate text-xs text-muted-foreground" title={r.note}>{r.note}</span>}
              </span>
            ),
          },
          {
            key: "w",
            label: "当时",
            render: (r) => <span className="whitespace-nowrap text-xs" title={`判定时的门槛 ${r.labelledThreshold ?? "—"} · 平均分 ${r.labelledScore ?? "—"} · 第 ${r.version ?? 1} 次修改`}>{bj(r.updatedAt)} · {r.updatedBy}</span>,
          },
          {
            key: "x",
            label: "",
            render: (r) => <Button size="sm" tone="ghost" busy={pending === `del:${r.caseId}`} onClick={() => void run("DELETE", `/api/admin/gold/${r.caseId}`, undefined, { label: `del:${r.caseId}`, success: "已删除这条标注" })}>删除</Button>,
          },
        ]}
      />
    </Card>
  );
}

function Mistakes({ report }: { report: AdminGoldReport }) {
  const navigate = useNavigate();
  if (!report.disagreements.length) return null;
  return (
    <Card title="你与它不一致的地方" right={<Badge tone="warn">{report.disagreements.length} 条</Badge>} pad={false}>
      <DataTable
        rows={report.disagreements}
        rowKey={(r) => r.caseId}
        onRowClick={(r) => navigate(`/admin/content/${r.caseId}`)}
        columns={[
          { key: "t", label: "标题", render: (r) => <span className="block max-w-96 truncate">{r.title}</span> },
          { key: "k", label: "差在哪", render: (r) => <Badge tone={r.kind === "missed" ? "warn" : "bad"}>{r.kind === "missed" ? "它漏了" : "它多选"}</Badge> },
          { key: "g", label: "你标", render: (r) => <span className="whitespace-nowrap text-xs">{r.decision}</span> },
          { key: "s", label: "分数", render: (r) => <span className="whitespace-nowrap text-xs">{r.score ?? "—"} / {r.threshold ?? "—"} · {r.sourceTier}</span> },
          { key: "b", label: "段", render: (r) => <span className="whitespace-nowrap text-xs" title={BANDS[r.band]}>{r.band}</span> },
        ]}
      />
      <div className="px-4 pb-3 text-xs text-muted-foreground">点一行去「内容诊断」看全文与整条链路。错误集中在门槛附近才考虑改数字，集中在某一类内容才考虑改标准。</div>
    </Card>
  );
}
