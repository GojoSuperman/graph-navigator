/**
 * BM25 폴백 점수 하한 스윕.
 *
 *   node scripts/history/sweep-minscore.ts
 *
 * A+B(route 완화 · 본문 색인)로 **거절 동작이 바뀌었다.** 하한을 낮추면 개체 이름이
 * 없는 질문을 받을 수 있고, 높이면 범위 밖을 확실히 막는다. **눈대중으로 정하지 않고
 * 골든셋으로 잰다.** `tuned` + 거절 문항만 쓴다 — holdout 은 보지 않는다.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../../lib/pipeline.ts";
import { HistoryGraph } from "../../lib/history/graph.ts";
import { loadHistoryDocs } from "../../lib/history/data.ts";
import { historyDomain } from "../../lib/domains/history.ts";

const D = join(import.meta.dirname, "..", "..", "data", "history");
const g = new HistoryGraph(JSON.parse(await readFile(join(D, "graph.json"), "utf-8")));
const gold = JSON.parse(await readFile(join(D, "golden.json"), "utf-8"));
const docs = await loadHistoryDocs();

const answerable = gold.items.filter((i: any) => i.type === "answerable" && i.split === "tuned");
const refusals = gold.items.filter((i: any) => i.type === "refusal");
/** 개체 이름이 없는 질문 — A+B 가 받으려는 것 */
const CONCEPT = [
  { q: "실학을 연구한 학자는?", want: ["정약용", "유형원", "박제가", "김정희"] },
  { q: "독립운동을 한 사람들은?", want: ["의열단", "3·1 운동", "안창호", "김구", "박은식"] },
  { q: "임진왜란 때 수군을 이끈 장수는?", want: ["이순신", "임진왜란"] },
  { q: "훈민정음을 만든 왕은?", want: ["세종", "집현전", "훈민정음"] },
  { q: "동학 농민 운동을 이끈 사람은?", want: ["전봉준", "동학 농민 혁명", "동학 농민 운동"] },
];

console.log(`대상 — tuned 답변가능 ${answerable.length} · 거절 ${refusals.length} · 개념질문 ${CONCEPT.length}`);
console.log(`(holdout ${gold.items.filter((i: any) => i.split === "holdout").length}문항은 보지 않는다)\n`);
console.log("  하한  기존문항  거절     개념질문   비고");

for (const minScore of [0, 5, 10, 12, 15, 18, 22, 30]) {
  const app = build(historyDomain(g, { docs, minScore }));
  let ok = 0;
  for (const it of answerable) {
    const s: any = await app.invoke({ question: it.question });
    const got = new Set<string>(s.sources);
    if ((it.expected ?? []).every((d: string) => got.has(d))) ok++;
  }
  let rOk = 0;
  for (const it of refusals) {
    const s: any = await app.invoke({ question: it.question });
    if (s.refused) rOk++;
  }
  let cOk = 0;
  const miss: string[] = [];
  for (const c of CONCEPT) {
    const s: any = await app.invoke({ question: c.q });
    const hit = !s.refused && c.want.some((w) => s.seedIds.includes(w) || s.evidence.some((e: any) => e.id === w));
    if (hit) cOk++; else miss.push(c.q.slice(0, 10));
  }
  const pct = (a: number, b: number) => `${String(Math.round(a / b * 100)).padStart(3)}%`;
  console.log(`  ${String(minScore).padStart(3)}   ${pct(ok, answerable.length)}     ${pct(rOk, refusals.length)}    ${pct(cOk, CONCEPT.length)}    ${miss.length ? "놓침: " + miss.join(",") : ""}`);
}
