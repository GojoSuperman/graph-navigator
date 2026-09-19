/**
 * 질문 하나를 넣고 라우팅·씨앗·근거를 눈으로 확인한다.
 *
 *   node scripts/ask.ts "부산행 나온 배우가 나온 다른 영화 있어?"
 *
 * LLM 을 호출하지 않는다. 최종 문장 직전까지 — 무엇을 근거로 데려왔는지 — 만 보여 준다.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MovieGraph, collectEvidence, DEFAULT_BUDGET, describePath } from "../lib/graph.ts";
import { route, findSeeds, canAnswer } from "../lib/route.ts";

const q = process.argv.slice(2).join(" ").trim();
if (!q) { console.error('사용법: node scripts/ask.ts "질문"'); process.exit(1); }

const data = JSON.parse(await readFile(join(import.meta.dirname, "..", "data", "graph.json"), "utf-8"));
const g = new MovieGraph(data);

const r = route(q);
const seeds = findSeeds(q, g);
const got = collectEvidence(g, seeds, DEFAULT_BUDGET, r.route);
const gate = canAnswer(r, seeds, got.movies.length);

const L = (s = "") => console.log(s);
L();
L(`질문  ${q}`);
L("─".repeat(72));
L(`라우팅  ${r.route}  — ${r.reason}`);
L(`씨앗    ${seeds.map((s) => g.movie(s)?.title ?? s).join("  ·  ") || "(없음)"}`);
L();
if (!gate.ok) {
  L(`⛔ 거절 — ${gate.reason}`);
  L(`   근거가 없으므로 LLM 을 호출하지 않는다.`);
  L("─".repeat(72)); L(); process.exit(0);
}
L(`✅ 근거 ${got.movies.length}편` + (got.dropped ? `  (예산으로 잘라낸 것 ${got.dropped})` : ""));
L();
for (const m of got.movies) {
  const path = got.paths.get(m.id) ?? [];
  const flag = m.originalLanguage === "ko" ? "🇰🇷" : "  ";
  L(`  ${flag} ${m.title}${m.year ? ` (${m.year})` : ""}  ★${m.voteAverage.toFixed(1)}`);
  L(`      ${m.genres.join(" · ")}`);
  if (path.length) L(`      경로: ${describePath(g, path)}`);
  else L(`      경로: (씨앗)`);
  L(`      ${m.overview.replace(/\s+/g, " ").slice(0, 80)}…`);
  L();
}
L("─".repeat(72)); L();
