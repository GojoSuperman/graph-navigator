/**
 * 한국사 질의 — 사람이 직접 물어 보는 CLI.
 *
 *   node scripts/history/ask.ts "안창호가 세운 조직은?"
 *
 * 답변 문장(LLM)은 붙이지 않는다. **근거·경로·삼중항·출처가 제대로 나오는지**를
 * 모델 없이 보기 위한 것이다.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../../lib/pipeline.ts";
import { HistoryGraph } from "../../lib/history/graph.ts";
import { historyDomain, evidenceBlock, pathLines } from "../../lib/domains/history.ts";

const data = JSON.parse(await readFile(
  join(import.meta.dirname, "..", "..", "data", "history", "graph.json"), "utf-8"));
const g = new HistoryGraph(data);
const app = build(historyDomain(g));

const q = process.argv.slice(2).join(" ") || "안창호가 세운 조직은?";
const s: any = await app.invoke({ question: q });

console.log(`\n질문   ${s.question}`);
console.log(`경유   ${s.trace.join(" → ")}`);
console.log(`라우팅  ${s.routeKind} — ${s.reason}`);
if (s.refused) { console.log(`\n거절   ${s.refusalReason}\n`); process.exit(0); }
console.log(`씨앗   ${s.seedIds.join(" · ")}`);
console.log(`근거   노드 ${s.evidence.length}개 · 삼중항 ${s.triples.length}개 · 출처 ${s.sources.length}건 (버림 ${s.dropped} · 허브차단 ${s.blocked})`);
console.log(`\n── 탄 경로 ──`);
pathLines(s, 8).forEach((l) => console.log(`  ${l}`));
console.log(`\n── 삼중항·근거·출처 ──`);
console.log(evidenceBlock(s, 6));
console.log(`\n출처 문서  ${s.sources.slice(0, 8).join(" · ")}\n`);
