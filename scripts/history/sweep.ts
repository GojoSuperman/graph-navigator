/**
 * 6단계 — 홉·허브 실측 스윕.
 *
 *   node scripts/history/sweep.ts
 *
 * 설계서 §6 은 홉 상한과 허브 기준을 "정하고 이유를 붙이는 것이 아니라, 재고 나서
 * 붙인다" 고 선언했다. **그 측정이 여기다.** 값을 바꿔 가며 컨텍스트 재현율을 재고
 * **꺾이는 지점**을 고른다.
 *
 * **`tuned` 묶음만 쓴다.** holdout 을 보고 값을 고르면 홀드아웃이 홀드아웃이 아니게
 * 된다 — 그러면 §7 의 과적합 측정이 통째로 무의미해진다.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../../lib/pipeline.ts";
import { HistoryGraph } from "../../lib/history/graph.ts";
import { historyDomain } from "../../lib/domains/history.ts";

const OUT = join(import.meta.dirname, "..", "..", "data", "history");
const data = JSON.parse(await readFile(join(OUT, "graph.json"), "utf-8"));
const gold = JSON.parse(await readFile(join(OUT, "golden.json"), "utf-8"));

const items = gold.items.filter((i: any) => i.split === "tuned" && i.type === "answerable");
const refusals = gold.items.filter((i: any) => i.split === "tuned" && i.type === "refusal");
console.log(`스윕 대상 — tuned 답변가능 ${items.length}문항 · 거절 ${refusals.length}문항`);
console.log(`(holdout ${gold.items.filter((i: any) => i.split === "holdout").length}문항은 **건드리지 않는다**)\n`);

interface Row {
  maxHops: number; hubTop: number; maxNodes: number; perKind: number;
  recall: number; pathRecall: number; byHop: Record<number, string>; refusal: number; avgEvidence: number;
}

/**
 * 기대 경로에 적은 **홉이 실제로 탄 경로에 있는가.**
 *
 * 컨텍스트 재현율만 보면 "근거는 데려왔는데 경로는 엉뚱한" 경우를 놓친다.
 * 루브릭 2가 "실제로 탄 경로를 제시하는가" 를 묻는 이상 이것을 따로 재야 하고,
 * **홉 상한을 2로 내릴지 3으로 둘지가 여기서 갈린다.**
 */
function pathHit(expected: string, actual: { from: string; to: string }[]): number {
  // "A ─KIND─▶ B ◀─KIND─ C" 에서 인접 쌍을 뽑는다
  const names = expected.split(/─+[A-Z_]*─*[▶◀]?/).map((x) => x.replace(/[▶◀─]/g, "").trim()).filter(Boolean);
  if (names.length < 2) return 1;
  const want = names.slice(0, -1).map((n, i) => [n, names[i + 1]] as const);
  const have = new Set(actual.flatMap((h) => [`${h.from}|${h.to}`, `${h.to}|${h.from}`]));
  return want.filter(([a, b]) => have.has(`${a}|${b}`)).length / want.length;
}

async function measure(maxHops: number, hubTop: number, maxNodes: number, perKind: number): Promise<Row> {
  const g = new HistoryGraph(data, hubTop);
  const app = build(historyDomain(g, { budget: { maxHops, maxNodes, perKind } }));
  const hit: Record<number, [number, number]> = { 1: [0, 0], 2: [0, 0], 3: [0, 0] };
  let ok = 0, ev = 0, pr = 0, prN = 0;
  for (const it of items) {
    const s: any = await app.invoke({ question: it.question });
    ev += s.evidence.length;
    const got = new Set<string>(s.sources);
    const want: string[] = it.expected ?? [];
    const good = want.length ? want.every((d) => got.has(d)) : !s.refused;
    if (good) ok++;
    if (it.path && !it.path.startsWith("(")) { pr += pathHit(it.path, s.path ?? []); prN++; }
    const h = hit[it.hops] ?? (hit[it.hops] = [0, 0]);
    h[1]++; if (good) h[0]++;
  }
  // 예산을 넓히면 **거절해야 할 것까지 답하게 되는지**도 같이 본다
  let rOk = 0;
  for (const it of refusals) {
    const s: any = await app.invoke({ question: it.question });
    if (s.refused) rOk++;
  }
  return {
    maxHops, hubTop, maxNodes, perKind,
    recall: ok / items.length,
    pathRecall: prN ? pr / prN : 0,
    byHop: Object.fromEntries(Object.entries(hit).map(([k, [a, b]]) => [k, b ? `${a}/${b}` : "-"])),
    refusal: rOk / Math.max(1, refusals.length),
    avgEvidence: ev / items.length,
  };
}

const rows: Row[] = [];
const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);

// ── ① 홉 상한 ─────────────────────────────────────────────────────────
console.log("── 홉 상한 (허브 8 · 노드 40 · 관계당 12 고정) ──────────────");
console.log("  홉  재현율 경로재현  1홉    2홉    3홉   거절  평균근거");
for (const h of [1, 2, 3, 4, 5]) {
  const r = await measure(h, 8, 40, 12); rows.push(r);
  console.log(`  ${h}  ${pct(r.recall)}   ${pct(r.pathRecall)}  ${r.byHop[1].padStart(5)} ${r.byHop[2].padStart(6)} ${r.byHop[3].padStart(6)}  ${pct(r.refusal)}  ${r.avgEvidence.toFixed(0)}`)
}

// ── ② 허브 통과 금지 개수 ─────────────────────────────────────────────
console.log("\n── 허브 통과 금지 상위 n개 (홉 3 · 노드 40 · 관계당 12) ─────");
console.log("   n  재현율   1홉    2홉    3홉   거절  평균근거");
for (const hub of [0, 2, 4, 8, 16, 32]) {
  const r = await measure(3, hub, 40, 12); rows.push(r);
  console.log(`  ${String(hub).padStart(2)}  ${pct(r.recall)}  ${r.byHop[1].padStart(5)} ${r.byHop[2].padStart(6)} ${r.byHop[3].padStart(6)}  ${pct(r.refusal)}  ${r.avgEvidence.toFixed(0)}`);
}

// ── ③ 근거 예산 ───────────────────────────────────────────────────────
console.log("\n── 근거 노드 상한 (홉 3 · 허브 8 · 관계당 12) ───────────────");
console.log("  노드 재현율   1홉    2홉    3홉   거절  평균근거");
for (const mn of [20, 40, 80, 160]) {
  const r = await measure(3, 8, mn, 12); rows.push(r);
  console.log(`  ${String(mn).padStart(3)} ${pct(r.recall)}  ${r.byHop[1].padStart(5)} ${r.byHop[2].padStart(6)} ${r.byHop[3].padStart(6)}  ${pct(r.refusal)}  ${r.avgEvidence.toFixed(0)}`);
}

// ── ④ 관계당 상한 ─────────────────────────────────────────────────────
console.log("\n── 관계당 상한 (홉 3 · 허브 8 · 노드 80) ────────────────────");
console.log("  /kind 재현율  1홉    2홉    3홉   거절  평균근거");
for (const pk of [4, 8, 12, 24, 48]) {
  const r = await measure(3, 8, 80, pk); rows.push(r);
  console.log(`  ${String(pk).padStart(4)}  ${pct(r.recall)}  ${r.byHop[1].padStart(5)} ${r.byHop[2].padStart(6)} ${r.byHop[3].padStart(6)}  ${pct(r.refusal)}  ${r.avgEvidence.toFixed(0)}`);
}

await writeFile(join(import.meta.dirname, "..", "..", "output", "history", "hop-sweep.json"),
  JSON.stringify({ ranAt: new Date().toISOString(), split: "tuned", items: items.length, rows }, null, 2));
console.log(`\n→ output/history/hop-sweep.json`);

// ── ⑤ 확정 후보 근처에서 홉을 다시 잰다 ────────────────────────────────
//
// ①의 홉 스윕은 **노드 40** 에서 쟀는데, ③이 80 을 꺾이는 지점으로 지목했다.
// 병목이 바뀌었으므로 홉의 효과도 다시 봐야 한다. 안 그러면 "홉 2로 충분하다" 를
// 근거 예산이 모자란 상태에서 내린 결론으로 쓰게 된다.
console.log("\n── 홉 상한 재측정 (노드 80 · 허브 8 · 관계당 12) ────────────");
console.log("  홉  재현율 경로재현  1홉    2홉    3홉   거절  평균근거");
for (const h of [1, 2, 3, 4]) {
  const r = await measure(h, 8, 80, 12); rows.push(r);
  console.log(`  ${h}  ${pct(r.recall)}   ${pct(r.pathRecall)}  ${r.byHop[1].padStart(5)} ${r.byHop[2].padStart(6)} ${r.byHop[3].padStart(6)}  ${pct(r.refusal)}  ${r.avgEvidence.toFixed(0)}`)
}
await writeFile(join(import.meta.dirname, "..", "..", "output", "history", "hop-sweep.json"),
  JSON.stringify({ ranAt: new Date().toISOString(), split: "tuned", items: items.length, rows }, null, 2));
