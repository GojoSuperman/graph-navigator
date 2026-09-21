/**
 * 7.2b — **근거 크기와 답변 정확도의 교환 관계.**
 *
 *   node --env-file-if-exists=.env.local scripts/history/sweep-answer.ts
 *
 * 6단계 스윕은 **컨텍스트 재현율만 보고** `maxNodes=80` 을 골랐다. 그런데 답변 층을
 * 재 보니 틀린 22건 중 12건이 "근거는 왔는데 모델이 못 찾은" 경우였고, 삼중항이
 * 150개씩 쌓인 문항에 몰려 있었다.
 *
 * **재현율은 오르고 답변은 떨어지는 교환이 있다면, 한쪽만 보고 고른 값은 틀렸다.**
 * 여기서 두 지표를 같이 놓고 다시 고른다.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../../lib/pipeline.ts";
import { HistoryGraph } from "../../lib/history/graph.ts";
import { historyDomain } from "../../lib/domains/history.ts";
import { evidenceBlock, generate, MODEL } from "../../lib/history/answer.ts";

const DATA = join(import.meta.dirname, "..", "..", "data", "history");
const OUT = join(import.meta.dirname, "..", "..", "output", "history");
const CACHE = join(OUT, "answer-cache.json");

const g = new HistoryGraph(JSON.parse(await readFile(join(DATA, "graph.json"), "utf-8")));
const gold = JSON.parse(await readFile(join(DATA, "golden.json"), "utf-8"));
const items = gold.items.filter((i: any) => i.type === "answerable");
const cache: Record<string, string> = await readFile(CACHE, "utf-8").then(JSON.parse).catch(() => ({}));

const norm = (s: string) => s.replace(/[·・.\s《》「」"'()]/g, "");
const contains = (a: string, e: string) => e.split(/\s*·\s*/).some((x) => norm(a).includes(norm(x)));
let calls = 0;

const rows: any[] = [];
console.log("  노드  컨텍스트재현율  답변정확도  평균삼중항  \"확인안됨\"");
for (const maxNodes of [10, 20, 40, 80]) {
  const app = build(historyDomain(g, { budget: { maxHops: 2, maxNodes, perKind: 12 } }));
  let ctx = 0, ans = 0, tri = 0, dunno = 0;
  for (const it of items) {
    const s: any = await app.invoke({ question: it.question });
    const got = new Set<string>(s.sources);
    if ((it.expected ?? []).every((d: string) => got.has(d))) ctx++;
    tri += s.triples.length;

    const ev = evidenceBlock(s.triples, s.evidence.map((e: any) => e.path));
    const ck = `${MODEL}|${it.id}|${ev.length}|${s.triples.length}`;
    let answer = cache[ck];
    if (answer === undefined) {
      answer = (await generate(it.question, ev)) ?? ""; cache[ck] = answer; calls++;
      if (calls % 10 === 0) await writeFile(CACHE, JSON.stringify(cache, null, 1));
    }
    const refused = /확인되지 않습니다|확인할 수 없습니다/.test(answer);
    if (refused) dunno++;
    if (!refused && contains(answer, it.answer)) ans++;
    process.stdout.write(`\r  ${String(maxNodes).padStart(3)} … ${it.id}      `);
  }
  const n = items.length;
  rows.push({ maxNodes, ctx: ctx / n, ans: ans / n, tri: tri / n, dunno });
  process.stdout.write(`\r  ${String(maxNodes).padStart(3)}    ${String(Math.round(ctx / n * 100)).padStart(3)}%          ${String(Math.round(ans / n * 100)).padStart(3)}%        ${String(Math.round(tri / n)).padStart(3)}        ${dunno}건\n`);
}
await writeFile(CACHE, JSON.stringify(cache, null, 1));
await writeFile(join(OUT, "answer-sweep.json"), JSON.stringify({ ranAt: new Date().toISOString(), model: MODEL, rows }, null, 2));
console.log(`\n  LLM 호출 ${calls}회 · → output/history/answer-sweep.json\n`);
