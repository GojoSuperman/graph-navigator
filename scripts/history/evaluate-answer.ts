/**
 * 7.2단계 — 답변 정확도 (평가의 **세 번째 층**).
 *
 *   node --env-file-if-exists=.env.local scripts/history/evaluate-answer.ts
 *
 * **이 층을 왜 반드시 만드는가.** 영화에서 근거 12편이 완벽한데 답변만 고장난 적이
 * 있었고, 그때 컨텍스트 재현율은 **한 칸도 안 움직였다.** 안 재는 층에서 나는 고장은
 * 숫자로 안 잡힌다.
 *
 * 채점은 사람이 정한 기대 정답과 대조한다 — 문자열 포함으로 1차 판정하고,
 * 애매한 것만 목록에 남겨 **사람이 읽는다.** 채점까지 LLM 에 맡기면 무엇이 틀렸는지
 * 아무도 모르게 된다.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../../lib/pipeline.ts";
import { HistoryGraph } from "../../lib/history/graph.ts";
import { loadHistoryDocs } from "../../lib/history/data.ts";
import { historyDomain } from "../../lib/domains/history.ts";
import { evidenceBlock, generate, MODEL } from "../../lib/history/answer.ts";

const DATA = join(import.meta.dirname, "..", "..", "data", "history");
const OUT = join(import.meta.dirname, "..", "..", "output", "history");
const CACHE = join(OUT, "answer-cache.json");

const g = new HistoryGraph(JSON.parse(await readFile(join(DATA, "graph.json"), "utf-8")));
const gold = JSON.parse(await readFile(join(DATA, "golden.json"), "utf-8"));
const docs = await loadHistoryDocs();
const app = build(historyDomain(g, { docs }));
const cache: Record<string, string> = await readFile(CACHE, "utf-8").then(JSON.parse).catch(() => ({}));

const norm = (s: string) => s.replace(/[·・.\s《》「」"'()]/g, "");
/** 기대 정답이 답변 안에 있는가. 여러 개면 하나만 맞아도 인정한다 */
const contains = (answer: string, expect: string) =>
  expect.split(/\s*·\s*/).some((x) => norm(answer).includes(norm(x)));

const rows: any[] = [];
let calls = 0;

for (const it of gold.items) {
  const s: any = await app.invoke({ question: it.question });

  if (it.type === "refusal") {
    // 거절 문항은 **LLM 을 부르지도 않아야** 한다 — 부르면 그 자체가 고장이다
    rows.push({ id: it.id, split: it.split, kind: "refusal", ok: s.refused, answer: null, called: false });
    continue;
  }

  const ev = evidenceBlock(s.triples, s.evidence.map((e: any) => e.path));
  const ck = `${MODEL}|${it.id}|${ev.length}|${s.triples.length}`;
  let answer = cache[ck];
  if (answer === undefined) {
    answer = (await generate(it.question, ev)) ?? "";
    cache[ck] = answer; calls++;
    await writeFile(CACHE, JSON.stringify(cache, null, 1));
  }

  const refusedByModel = /확인되지 않습니다|확인할 수 없습니다/.test(answer);
  const ok = !refusedByModel && contains(answer, it.answer);
  rows.push({
    id: it.id, split: it.split, hops: it.hops, era: it.era, kind: "answerable",
    ok, refusedByModel, expect: it.answer, answer: answer.slice(0, 160),
    evidenceSize: s.triples.length, sources: s.sources.length,
  });
  process.stdout.write(`\r  ${rows.length}/${gold.items.length}  ${it.id}   `);
}

const ans = rows.filter((r) => r.kind === "answerable");
const ref = rows.filter((r) => r.kind === "refusal");
const pct = (a: number, b: number) => b ? `${String(a).padStart(2)}/${String(b).padEnd(2)} (${String(Math.round(a / b * 100)).padStart(3)}%)` : "-";
const by = (key: string, order: string[]) => {
  for (const k of order) {
    const rs = ans.filter((r) => String(r[key]) === k);
    if (rs.length) console.log(`  ${k.padEnd(13)} ${pct(rs.filter((r) => r.ok).length, rs.length)}`);
  }
};

console.log(`\n\n════ 답변 정확도 (LLM ${calls}회 호출 · 나머지 캐시) ════`);
console.log(`  ── 홉 수별 ──`); by("hops", ["1", "2", "3"]);
console.log(`  ── 묶음별 ──`); by("split", ["tuned", "holdout", "bridge-hard"]);
console.log(`  ── 시대별 ──`); by("era", ["조선 전·중기", "조선 후기", "구한말·일제", "해방·현대", "시대 교차"]);
console.log(`  ──`);
console.log(`  ${"전체".padEnd(13)} ${pct(ans.filter((r) => r.ok).length, ans.length)}`);
console.log(`  ${"거절".padEnd(13)} ${pct(ref.filter((r) => r.ok).length, ref.length)}`);
console.log(`\n  근거는 왔는데 모델이 "확인되지 않습니다" 로 답한 것 — ${ans.filter((r) => r.refusedByModel).length}건`);

console.log(`\n════ 틀린 답변 (손으로 읽을 것) ════`);
for (const r of ans.filter((x) => !x.ok)) {
  console.log(`  [${r.split}] ${r.id} ${r.hops}홉 · 삼중항 ${r.evidenceSize}개`);
  console.log(`      기대: ${r.expect}`);
  console.log(`      실제: ${r.answer}`);
}

await writeFile(join(OUT, "eval-answer.json"), JSON.stringify({ ranAt: new Date().toISOString(), model: MODEL, rows }, null, 2));
console.log(`\n→ output/history/eval-answer.json\n`);
