/**
 * 골든셋 자체 점검 — **채점이 아니다.**
 *
 *   node scripts/history/check-golden.ts
 *
 * 문항이 형식을 갖췄는지, 기대 경로에 적은 노드·관계가 **그래프에 실재하는지**만 본다.
 * 여기서 걸리면 골든셋이 틀린 것이지 시스템이 틀린 것이 아니다.
 * (실제 채점은 6·7단계 `evaluate.ts` 가 한다.)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EDGE_KINDS } from "../../lib/history/config.ts";

const OUT = join(import.meta.dirname, "..", "..", "data", "history");
const g = JSON.parse(await readFile(join(OUT, "graph.json"), "utf-8"));
const gold = JSON.parse(await readFile(join(OUT, "golden.json"), "utf-8"));

const nodes = new Set<string>(g.nodes.map((n: any) => n.id));
const edgeKey = new Set<string>(g.edges.map((e: any) => `${e.from}|${e.kind}|${e.to}`));
const quotes = new Set<string>(g.edges.flatMap((e: any) => e.quotes));
const docs = new Set<string>(g.edges.flatMap((e: any) => e.docs));

let bad = 0;
const warn = (id: string, msg: string) => { console.log(`  ✗ ${id.padEnd(7)} ${msg}`); bad++; };

for (const it of gold.items) {
  // ── 필수 필드 — **유형마다 다르다** (거절 문항엔 경로·근거가 없다)
  if (!it.question || !it.answer) warn(it.id, "question·answer 누락");
  if (it.type === "refusal") {
    if (it.hops !== 0) warn(it.id, "거절 문항은 hops 0 이어야 한다");
    continue;
  }
  if (![1, 2, 3].includes(it.hops)) warn(it.id, `hops 가 ${it.hops}`);
  if (!it.era) warn(it.id, "era 누락");
  if (!Object.keys(gold.splits).includes(it.split)) warn(it.id, "split 이 tuned/holdout 이 아니다");

  // ── 경로에 적은 노드가 그래프에 있는가
  const inPath = (it.path as string).split(/─+[A-Z_]*─*[▶◀]?|\//)
    .map((s) => s.replace(/[▶◀─]/g, "").trim()).filter((s) => s && !s.startsWith("("));
  for (const n of inPath) {
    if (!nodes.has(n)) warn(it.id, `경로의 노드가 그래프에 없다 — 《${n}》`);
  }
  // ── 경로에 적은 관계가 스키마 안인가
  for (const m of (it.path as string).matchAll(/─([A-Z_]{3,})─/g)) {
    if (!EDGE_KINDS.includes(m[1] as any)) warn(it.id, `스키마 밖 관계 — ${m[1]}`);
  }
  // ── 근거 문장이 그래프의 근거에 실재하는가 (부분 일치 허용 — 문항은 잘라 적는다)
  if (it.quote) {
    const hit = [...quotes].some((q) => q.includes(it.quote) || it.quote.includes(q));
    if (!hit) warn(it.id, `근거 문장이 그래프에 없다 — "${it.quote.slice(0, 32)}…"`);
  } else if (it.path && !it.path.startsWith("(")) {
    warn(it.id, "근거 문장이 비었다");
  }
  // ── 기대 문서가 코퍼스에 있는가
  for (const d of it.expected ?? []) if (!docs.has(d)) warn(it.id, `기대 문서가 근거에 없다 — 《${d}》`);
}

const n = gold.items.length;
console.log(`\n문항 ${n}개 · 문제 ${bad}건`);
process.exitCode = bad ? 1 : 0;
