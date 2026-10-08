// 分叉体检：我们相对 fork 点的每一处改动，在「上游现在这棵树」上还站不站得住。
// 只读 git——不连库、不出网、不写盘，**永远 exit 0**：上游搬走文件、对向删除、两边都改，
// 都不是缺陷，判断留给真要做 rebase 的那个人。它存在的理由只有一个：上游一直在提交，
// 任何写死在文档里的分叉分类都会在几周内变成假的（2026-10-06 就发生过——文档说落后 12 个
// commit，fetch 之后是 66 个）。跑法：
//   node scripts/audit-divergence.ts
// 三棵树必须在：fork 点、我们的主线、上游的当前头。上游那一棵用 `git fetch upstream` 取，
// 它只动 refs/remotes/upstream/*，不碰工作树。想换口径就设 DIVERGENCE_BASE / DIVERGENCE_US /
// DIVERGENCE_UPSTREAM。
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BASE = process.env.DIVERGENCE_BASE ?? "main";
const US = process.env.DIVERGENCE_US ?? "dev";
const UP = process.env.DIVERGENCE_UPSTREAM ?? "upstream/main";
/** git 自己的改名检测默认要 50% 相似；低于它它就不认为是同一个文件了。 */
const GIT_DEFAULT = 50;

const git = (...args: string[]) =>
  execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd: ROOT, encoding: "utf8" });

function hasRev(name: string) {
  try {
    git("rev-parse", "--verify", "--quiet", `${name}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

type Entry = { status: string; path: string; to?: string };

function nameStatus(revs: string[], opts: string[] = ["-M"]): Entry[] {
  return git("diff", "--name-status", ...opts, ...revs)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const cols = line.split("\t");
      const status = cols[0] ?? "";
      const path = cols[1] ?? "";
      return status.startsWith("R") ? { status, path, to: cols[2] } : { status, path };
    });
}

if (![BASE, US, UP].every(hasRev)) {
  console.log(`✗ 分叉体检要三棵树都在：fork 点 ${BASE}、主线 ${US}、上游当前头 ${UP}。`);
  console.log("  缺上游那一棵时先跑 `git fetch upstream`——它只动 refs/remotes/upstream/*。");
  console.log("体检没有跑完；这不算失败，所以退出码仍是 0。");
  process.exit(0);
}

console.log(`分叉体检：${BASE} → ${US}（我们这侧）对 ${BASE} → ${UP}（上游那侧）\n`);

const ours = nameStatus([`${BASE}..${US}`]);
const theirs = nameStatus([BASE, UP]);
// 同一件事再问一次，但把改名阈值压到 10%：那些「上游删了旧路径、建了新路径，而默认阈值
// 认不出是同一个文件」的情况，只有这次才配得上对——配出来的相似度就是那一行的数字。
const loose = nameStatus([BASE, UP], ["-M10"]);

const theirStatus = new Map<string, Entry>();
const movedByDefault = new Map<string, string>();
for (const e of theirs) {
  theirStatus.set(e.path, e);
  if (e.status.startsWith("R") && e.to) movedByDefault.set(e.path, e.to);
}
const movedAtAll = new Map<string, { to: string; score: number }>();
for (const e of loose) {
  if (e.status.startsWith("R") && e.to) movedAtAll.set(e.path, { to: e.to, score: Number(e.status.slice(1)) });
}
const addedByThem = new Set(theirs.filter((e) => e.status[0] === "A").map((e) => e.path));

const counts = new Map<string, number>();
const bump = (kind: string) => counts.set(kind, (counts.get(kind) ?? 0) + 1);
const read = (kind: string) => counts.get(kind) ?? 0;

for (const e of ours) {
  const s = e.status[0];
  const them = theirStatus.get(e.path);
  if (s === "A") {
    if (them?.status[0] === "A") bump("新增/上游也新建了同名文件");
    else if (them) bump("新增/上游对这个路径另有动作");
    else bump("新增/上游没有这个路径");
  } else if (s === "M") {
    if (!them) bump("改动/上游没碰");
    else if (them.status[0] === "M") bump("改动/两边都改");
    else if (movedByDefault.has(e.path)) bump("改动/上游搬走了(默认阈值认得出)");
    else if (them.status[0] === "D") bump("改动/上游删了(或搬到默认阈值认不出的地方)");
    else bump("改动/上游对它另有动作");
  } else if (s === "D") {
    if (!them) bump("删除/上游没碰(我们单方删的)");
    else if (them.status[0] === "D") bump("删除/上游也删了(同向)");
    else if (them.status.startsWith("R")) bump("删除/上游把它改名了");
    else bump("删除/上游还在改它(modify/delete)");
  } else bump(`其他(${e.status})`);
}

const group = (prefix: string) =>
  [...counts.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, n]) => `${k.slice(prefix.length)} ${n}`).join("，");
console.log(`我们这侧共 ${ours.length} 条路径：`);
for (const p of ["新增/", "改动/", "删除/"]) if (group(p)) console.log(`  ${p.slice(0, -1)}：${group(p)}`);
console.log(`  其他：${[...counts.entries()].filter(([k]) => !/^(新增|改动|删除)\//.test(k)).map(([k, n]) => `${k} ${n}`).join("，") || "无"}`);
console.log(`上游那侧共 ${theirs.length} 条路径。\n`);

// 最要紧的一段：我们改过、而上游「删了」的那些——如果它们其实是搬去了新路径，
// 而搬动两边都改了内容（相似度低于默认阈值），那合并时新路径**不冲突**，会照单全收
// 上游那一份，我们改过的旧路径只以一条 modify/delete 出现。文档要人判的东西就在这几行里。
const silent = ours
  .filter((e) => e.status[0] === "M" && theirStatus.get(e.path)?.status[0] === "D")
  .map((e) => ({ path: e.path, move: movedAtAll.get(e.path) }))
  .filter((x): x is { path: string; move: { to: string; score: number } } => !!x.move && addedByThem.has(x.move.to));

console.log(`上游删了、我们也改过、而低阈值能配上「新路径」的那些（相似度就是两边各自重写的程度）：`);
for (const x of silent) {
  if (x.move.score < GIT_DEFAULT) {
    console.log(`  ! ${x.path} → ${x.move.to}：相似度 ${x.move.score}%——**这不是搬家，是两边各自重写**`);
    console.log(`    合并时 ${x.move.to} 不冲突（我们这侧没有它），会安静地拿上游那一份；`);
    console.log(`    我们改过的 ${x.path} 只以一条 modify/delete 出现。要先手工把内容移植过去，**别靠压低改名阈值**——`);
    console.log(`    压低阈值只是命令 git 把两个只有 ${x.move.score}% 相同的文件当成一个来合。`);
  } else {
    console.log(`  · ${x.path} → ${x.move.to}（相似度 ${x.move.score}%，内容同源，改名检测能带过去）`);
  }
}
if (!silent.length) console.log("  （没有：上游删掉的我们改过的路径，低阈值也配不出新路径——那就是真删）");

console.log(`\n每个数字都属于它跑的那一刻。上游又提交了就重跑这一条；判断归人，所以它永远 exit 0。`);
