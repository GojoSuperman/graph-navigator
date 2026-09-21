/**
 * 7단계 — 평가. **LLM 호출 0회.**
 *
 *   node scripts/history/evaluate.ts
 *
 * 재는 것 셋 중 둘을 여기서 잰다 (설계서 §7) —
 *   ① 컨텍스트 재현율 — 기대 문서가 근거에 들어왔는가 (그래프 vs BM25 대조)
 *   ② 경로 재현율     — 기대 경로의 홉이 실제 탄 경로에 있는가
 * 세 번째(답변 정확도)는 LLM 이 필요해 `evaluate-answer.ts` 가 따로 잰다.
 *
 * **평균을 내지 않는다.** 루브릭이 "평균이 아니라 홉 수별로" 를 명시한다.
 * 홉별 · 시대별 · 묶음별로 갈라 낸다.
 */

import { readFile, readdir, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { BM25 } from "../../lib/bm25.ts";
import { build } from "../../lib/pipeline.ts";
import { HistoryGraph } from "../../lib/history/graph.ts";
import { loadHistoryDocs } from "../../lib/history/data.ts";
import { historyDomain } from "../../lib/domains/history.ts";

const DATA = join(import.meta.dirname, "..", "..", "data", "history");
const OUT = join(import.meta.dirname, "..", "..", "output", "history");
const RUNS = join(OUT, "runs.jsonl");

const graphData = JSON.parse(await readFile(join(DATA, "graph.json"), "utf-8"));
const gold = JSON.parse(await readFile(join(DATA, "golden.json"), "utf-8"));
const g = new HistoryGraph(graphData);

// ── 대조군: BM25 ─────────────────────────────────────────────────────
//
// 과제는 "basic RAG 대조" 라고 썼는데 BM25 를 쓴다. 대조군의 목적은 "그래프 없이
// 키워드만으로 어디까지 되는가" 이고, BM25 는 **LLM·임베딩 호출이 0회**라 하루에
// 몇 번이고 공짜로 다시 잰다. 임베딩 대조군은 비용이 들어 그 자리를 못 지킨다.
const docs: { id: string; title: string; text: string }[] = [];
for (const f of (await readdir(join(DATA, "docs"))).filter((x) => x.endsWith(".md"))) {
  const raw = await readFile(join(DATA, "docs", f), "utf-8");
  const title = raw.match(/^# (.+)$/m)?.[1] ?? f;
  docs.push({ id: title, title, text: raw.split(/\n\n/).slice(1).join("\n\n") });
}
const bm = new BM25(docs);

const items = gold.items.filter((i: any) => i.type === "answerable");
const refusals = gold.items.filter((i: any) => i.type === "refusal");
const nodeDocs = await loadHistoryDocs();
const app = build(historyDomain(g, {
  docs: nodeDocs,
  record: (name, s: any) => void appendFile(RUNS, JSON.stringify({
    at: new Date().toISOString(), domain: name, question: s.question,
    trace: s.trace, routeKind: s.routeKind, seeds: s.seedIds,
    path: s.path, triples: s.triples.slice(0, 40), sources: s.sources,
    refused: s.refused, refusalReason: s.refusalReason, answer: s.answerText,
  }) + "\n"),
}));

/** 기대 경로의 인접 쌍이 실제 탄 경로에 있는가 */
function pathHit(expected: string, actual: { from: string; to: string }[]): number | null {
  const names = expected.split(/─+[A-Z_]*─*[▶◀]?/).map((x) => x.replace(/[▶◀─]/g, "").trim()).filter(Boolean);
  if (names.length < 2) return null;
  const want = names.slice(0, -1).map((n, i) => [n, names[i + 1]] as const);
  const have = new Set(actual.flatMap((h) => [`${h.from}|${h.to}`, `${h.to}|${h.from}`]));
  return want.filter(([a, b]) => have.has(`${a}|${b}`)).length / want.length;
}

const corpusTitles = new Set(docs.map((d) => d.id));

interface Res {
  id: string; hops: number; era: string; split: string; question: string;
  graph: boolean; bm25: boolean; pathRecall: number | null;
  layer: "" | "색인" | "탐색"; sources: number; k: number; trace: string[];
}

await rm(RUNS, { force: true });
const res: Res[] = [];

for (const it of items) {
  const s: any = await app.invoke({ question: it.question });
  const got = new Set<string>(s.sources);
  const want: string[] = it.expected ?? [];
  const graphOk = want.length ? want.every((d) => got.has(d)) : !s.refused;

  // **같은 예산으로 준다** — 그래프가 데려온 출처 수만큼 BM25 에도 준다
  const k = Math.max(3, s.sources.length);
  const top = new Set(bm.search(it.question, k).map((r) => r.id));
  const bmOk = want.length ? want.every((d) => top.has(d)) : false;

  // 실패의 층 — **코드가 판정한다**
  let layer: Res["layer"] = "";
  if (!graphOk) layer = want.some((d) => !corpusTitles.has(d)) ? "색인" : "탐색";

  res.push({
    id: it.id, hops: it.hops, era: it.era, split: it.split, question: it.question,
    graph: graphOk, bm25: bmOk,
    pathRecall: it.path && !it.path.startsWith("(") ? pathHit(it.path, s.path ?? []) : null,
    layer, sources: s.sources.length, k, trace: s.trace,
  });
}

let refOk = 0;
for (const it of refusals) {
  const s: any = await app.invoke({ question: it.question });
  if (s.refused) refOk++;
}

// ── 출력 ─────────────────────────────────────────────────────────────
const L = console.log;
const pct = (a: number, b: number) => b ? `${String(a).padStart(2)}/${String(b).padEnd(2)} (${String(Math.round(a / b * 100)).padStart(3)}%)` : "   -     ";
const group = (rows: Res[], keyOf: (r: Res) => string, order?: string[]) => {
  const m = new Map<string, Res[]>();
  for (const r of rows) (m.get(keyOf(r)) ?? m.set(keyOf(r), []).get(keyOf(r))!).push(r);
  return (order ?? [...m.keys()]).filter((k) => m.has(k)).map((k) => [k, m.get(k)!] as const);
};
const line = (label: string, rs: Res[]) =>
  L(`  ${label.padEnd(12)} ${pct(rs.filter((r) => r.graph).length, rs.length)}   ${pct(rs.filter((r) => r.bm25).length, rs.length)}`);

L(`\n════ 컨텍스트 재현율 — 그래프 vs BM25 (같은 근거 예산) ════`);
L(`  ${"".padEnd(12)} 그래프          BM25`);
L(`  ── 홉 수별 (루브릭: "평균이 아니라 홉 수별로") ──`);
for (const [k, rs] of group(res, (r) => `${r.hops}홉`, ["1홉", "2홉", "3홉"])) line(k, rs);
L(`  ── 시대별 ──`);
for (const [k, rs] of group(res, (r) => r.era, ["조선 전·중기", "조선 후기", "구한말·일제", "해방·현대", "시대 교차"])) line(k, rs);
L(`  ── 묶음별 ──`);
for (const [k, rs] of group(res, (r) => r.split, ["tuned", "holdout", "bridge-hard"])) line(k, rs);
L(`  ──`);
line("전체", res);
L(`  거절          ${pct(refOk, refusals.length)}`);

const prs = res.filter((r) => r.pathRecall !== null);
L(`\n════ 경로 재현율 ════`);
for (const [k, rs] of group(prs, (r) => `${r.hops}홉`, ["1홉", "2홉", "3홉"])) {
  const v = rs.reduce((a, r) => a + (r.pathRecall ?? 0), 0) / rs.length;
  L(`  ${k.padEnd(12)} ${String(Math.round(v * 100)).padStart(3)}%  (${rs.length}문항)`);
}
L(`  ${"전체".padEnd(12)} ${String(Math.round(prs.reduce((a, r) => a + (r.pathRecall ?? 0), 0) / prs.length * 100)).padStart(3)}%`);

const fails = res.filter((r) => !r.graph);
L(`\n════ 실패의 층 (코드 판정) ════`);
L(`  색인 (기대 문서가 코퍼스에 없다)   ${fails.filter((f) => f.layer === "색인").length}건`);
L(`  탐색 (코퍼스엔 있는데 못 데려왔다) ${fails.filter((f) => f.layer === "탐색").length}건`);
L(`  생성 (근거엔 있는데 답을 못 했다)  — evaluate-answer.ts 가 잰다`);
for (const f of fails) L(`    [${f.layer}] ${f.id} ${f.hops}홉 · ${f.trace.join("→")} · 근거 ${f.sources}건 — ${f.question.slice(0, 30)}`);

const tuned = res.filter((r) => r.split === "tuned"), hold = res.filter((r) => r.split === "holdout");
const rate = (rs: Res[]) => rs.filter((r) => r.graph).length / rs.length;
L(`\n════ 과적합 ════`);
L(`  tuned ${Math.round(rate(tuned) * 100)}%  ·  holdout ${Math.round(rate(hold) * 100)}%  ·  격차 ${Math.round((rate(tuned) - rate(hold)) * 100)}%p`);

await writeFile(join(OUT, "eval.json"), JSON.stringify({
  ranAt: new Date().toISOString(), items: res.length, refusal: { ok: refOk, total: refusals.length }, results: res,
}, null, 2));
L(`\n→ output/history/eval.json · runs.jsonl\n`);
