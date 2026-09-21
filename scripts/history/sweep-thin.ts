/**
 * "막다른 노드" 차수 임계값(`thinDegree`) 스윕.
 *
 *   node scripts/history/sweep-thin.ts
 *
 * 이름이 걸려도 그 노드의 차수가 낮으면 BM25 로 씨앗을 보강한다. 임계값을 올리면
 * 보강이 잦아져 답을 더 찾지만 근거가 커지고 엉뚱한 씨앗이 섞인다.
 * **눈대중으로 정하지 않고 골든셋으로 잰다** — `tuned` + 거절만, holdout 은 안 본다.
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

const tuned = gold.items.filter((i: any) => i.type === "answerable" && i.split === "tuned");
const refusals = gold.items.filter((i: any) => i.type === "refusal");
/** 질문의 단어가 막다른 노드인 질문들 — C 가 받으려는 것 */
const THIN_Q = [
  { q: "조선시대 한글을 만드신 왕은 누구야?", want: ["세종"] },
  { q: "한글을 만든 왕은?", want: ["세종"] },
  { q: "조선을 건국한 사람은?", want: ["이성계"] },
];

console.log(`대상 — tuned ${tuned.length} · 거절 ${refusals.length} · 막다른질문 ${THIN_Q.length}\n`);
console.log("  차수  tuned  거절    막다른질문  평균근거  비고");

for (const thinDegree of [0, 2, 3, 5, 8, 12, 20]) {
  const app = build(historyDomain(g, { docs, thinDegree }));
  let ok = 0, ev = 0;
  for (const it of tuned) {
    const s: any = await app.invoke({ question: it.question });
    ev += s.evidence.length;
    const got = new Set<string>(s.sources);
    if ((it.expected ?? []).every((d: string) => got.has(d))) ok++;
  }
  let rOk = 0;
  for (const it of refusals) {
    const s: any = await app.invoke({ question: it.question });
    if (s.refused) rOk++;
  }
  let tOk = 0; const miss: string[] = [];
  for (const t of THIN_Q) {
    const s: any = await app.invoke({ question: t.q });
    const hit = t.want.every((w) => s.evidence.some((e: any) => e.id === w));
    if (hit) tOk++; else miss.push(t.want.join("/"));
  }
  const pct = (a: number, b: number) => `${String(Math.round(a / b * 100)).padStart(3)}%`;
  console.log(`  ${String(thinDegree).padStart(3)}   ${pct(ok, tuned.length)}  ${pct(rOk, refusals.length)}   ${pct(tOk, THIN_Q.length)}      ${String(Math.round(ev / tuned.length)).padStart(3)}     ${miss.length ? "놓침: " + miss.join(",") : ""}`);
}
