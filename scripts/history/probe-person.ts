/**
 * 인물 간 관계 시험 — **F(관계 2종 추가) 전후를 같은 문항으로 잰다.**
 *
 *   node scripts/history/probe-person.ts
 *
 * 골든셋과 따로 두는 이유: 이 문항들은 **지금 스키마가 구조적으로 못 담는 것**을
 * 겨냥한다. 골든셋에 섞으면 "스키마가 못 담아서 틀린 것" 과 "탐색이 못 찾아서
 * 틀린 것" 이 한 숫자에 뭉친다.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../../lib/pipeline.ts";
import { HistoryGraph } from "../../lib/history/graph.ts";
import { loadHistoryDocs } from "../../lib/history/data.ts";
import { historyDomain } from "../../lib/domains/history.ts";

const D = join(import.meta.dirname, "..", "..", "data", "history");
const g = new HistoryGraph(JSON.parse(await readFile(join(D, "graph.json"), "utf-8")));
const probe = JSON.parse(await readFile(join(D, "probe-person.json"), "utf-8"));
const app = build(historyDomain(g, { docs: await loadHistoryDocs() }));

const byKind = new Map<string, [number, number]>();
let ok = 0, refused = 0;
console.log(`\n인물 간 관계 시험 ${probe.items.length}문항\n`);
for (const it of probe.items) {
  const s: any = await app.invoke({ question: it.q });
  const ids = new Set<string>(s.evidence.map((e: any) => e.id));
  const hit = it.want.some((w: string) => ids.has(w));
  if (s.refused) refused++;
  if (hit) ok++;
  const k = byKind.get(it.kind) ?? [0, 0];
  byKind.set(it.kind, [k[0] + (hit ? 1 : 0), k[1] + 1]);
  const mark = hit ? "✅" : s.refused ? "🚫" : "❌";
  console.log(`  ${mark} ${it.id} [${it.kind}] ${it.q}`);
  console.log(`       기대 ${it.want.join("/")} · ${s.refused ? "거절" : `근거 ${s.evidence.length}개 · 씨앗 ${s.seedIds.join("·")}`}`);
}
console.log(`\n── 유형별 ──`);
for (const [k, [a, b]] of byKind) console.log(`  ${k.padEnd(6)} ${a}/${b}`);
console.log(`\n  전체 ${ok}/${probe.items.length} (${Math.round(ok / probe.items.length * 100)}%) · 거절 ${refused}건\n`);
