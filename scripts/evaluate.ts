/**
 * 그래프 탐색 vs BM25 — 컨텍스트 재현율 비교.
 *
 *   node scripts/evaluate.ts
 *
 * **LLM 을 호출하지 않는다.** 재는 것은 답변 정확도가 아니라
 * "정답에 필요한 근거를 데려왔는가" 다. 여기서 못 데려온 것은 뒤에 어떤 모델을
 * 붙여도 답에 못 쓴다 — 시스템의 상한선이다.
 *
 * law-navigator 에서 가장 값어치 있었던 부분을 그대로 옮겼다.
 * 다른 점 하나: **문항을 사용자가 직접 썼다.**
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MovieGraph, collectEvidence, DEFAULT_BUDGET } from "../lib/graph.ts";
import { BM25 } from "../lib/bm25.ts";
import { route, findSeeds, canAnswer, commonPeople } from "../lib/route.ts";
import { nameMatches } from "../lib/romanize.ts";

const DATA = join(import.meta.dirname, "..", "data");
const g = new MovieGraph(JSON.parse(await readFile(join(DATA, "graph.json"), "utf-8")));
const gold = JSON.parse(await readFile(join(DATA, "golden.json"), "utf-8"));

// 비교군은 **같은 토크나이저**를 써야 공정하다
const bm25 = new BM25(
  [...g.movies.values()].map((m) => ({ id: m.id, title: `${m.title} ${m.originalTitle}`, text: `${m.overview} ${m.genres.join(" ")}` })),
);

const REFUSE = ["out_of_scope"];
const titleOf = (id: string) => g.movie(id)?.title ?? id;

type Row = {
  id: string; kind: string; split: string; question: string;
  need: string | null; answer: string;
  route: string; refused: boolean;
  graphHit: boolean; bm25Hit: boolean; personHit: boolean;
  graphGot: string[];
};

/** 기준 작품이 근거에 들어왔는가 */
const hasMovie = (ids: string[], title: string) =>
  ids.some((id) => {
    const t = g.movie(id)?.title ?? "";
    return t === title || t.startsWith(title) || title.startsWith(t);
  });

const rows: Row[] = [];
for (const q of gold.items) {
  const r = route(q.question);
  const seeds = findSeeds(q.question, g);
  const got = collectEvidence(g, seeds, DEFAULT_BUDGET, r.route as any);
  const gate = canAnswer(r, seeds, got.movies.length);
  const graphGot = got.movies.map((m) => m.id);
  const bm25Got = bm25.search(q.question, DEFAULT_BUDGET.maxMovies).map((x) => x.id);

  // 배역 질문은 **사람**이 답이다. 근거 안에서 그 사람을 짚어낼 수 있는지도 본다.
  let personHit = false;
  if (q.needPerson) {
    const words = (q.question.match(/[가-힣]{2,5}/g) ?? []).flatMap((w: string) => [w, w.slice(0, -1)]);
    outer: for (const id of graphGot) {
      for (const e of g.creditsOf(id, "ACTED_IN")) {
        if (!e.as) continue;
        if (words.some((w: string) => w.length >= 2 && nameMatches(w, e.as!))) {
          if (g.person(e.from)?.name === q.needPerson) { personHit = true; break outer; }
        }
      }
    }
    if (!personHit) {
      // 작품 교집합 문항 — 공통 참여자에 정답이 있는가
      const cp = commonPeople(q.question, g);
      if (cp.people.some((p) => p.name === q.needPerson)) personHit = true;
    }
    if (!personHit) {
      // 인물 수상으로 답하는 문항
      for (const p of g.people.values()) {
        if (p.name === q.needPerson && p.awards?.length) { personHit = true; break; }
      }
    }
  }

  rows.push({
    id: q.id, kind: q.kind, split: q.split, question: q.question,
    need: q.needMovie || null, answer: q.answer,
    route: r.route, refused: !gate.ok,
    graphHit: q.needMovie ? hasMovie(graphGot, q.needMovie) : false,
    bm25Hit: q.needMovie ? hasMovie(bm25Got, q.needMovie) : false,
    personHit,
    graphGot,
  });
}

const L = (s = "") => console.log(s);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : "—");

L("═".repeat(78));
L(`  컨텍스트 재현율 — 그래프 탐색 vs BM25   (근거 예산 ${DEFAULT_BUDGET.maxMovies}편)`);
L("═".repeat(78));

const scored = rows.filter((r) => !REFUSE.includes(r.kind) && r.need);
L("\n  문항   유형          기대작품          그래프 BM25  라우팅");
L("  " + "─".repeat(70));
let last = "";
for (const r of scored) {
  if (r.split !== last) { L(`  ── ${gold.splits[r.split] ? r.split : r.split} ${"─".repeat(46)}`); last = r.split; }
  const mark = r.graphHit && !r.bm25Hit ? "▲" : !r.graphHit && r.bm25Hit ? "▼" : " ";
  L(`  ${mark} ${r.id.padEnd(5)} ${r.kind.padEnd(12)} ${String(r.need).slice(0, 14).padEnd(16)} ${(r.graphHit ? " ✅" : " ❌").padEnd(5)} ${(r.bm25Hit ? "✅" : "❌").padEnd(5)} ${r.route}`);
}

L("\n  [ 유형별 — 기준 작품을 근거로 데려왔는가 ]");
for (const kind of ["character", "filmography", "bridge", "intersect-movie", "intersect-person", "award", "content", "ranking"]) {
  const s = scored.filter((r) => r.kind === kind);
  if (!s.length) continue;
  const gh = s.filter((r) => r.graphHit).length, bh = s.filter((r) => r.bm25Hit).length;
  L(`    ${kind.padEnd(12)} 그래프 ${String(gh).padStart(2)}/${s.length}  (${pct(gh, s.length).padStart(4)})    BM25 ${String(bh).padStart(2)}/${s.length}  (${pct(bh, s.length).padStart(4)})`);
}
const GH = scored.filter((r) => r.graphHit).length, BH = scored.filter((r) => r.bm25Hit).length;
L(`    ${"전체".padEnd(12)} 그래프 ${GH}/${scored.length}  (${pct(GH, scored.length)})    BM25 ${BH}/${scored.length}  (${pct(BH, scored.length)})`);

L("\n  [ 묶음별 ]");
for (const sp of Object.keys(gold.splits)) {
  const s = scored.filter((r) => r.split === sp);
  if (!s.length) continue;
  const gh = s.filter((r) => r.graphHit).length, bh = s.filter((r) => r.bm25Hit).length;
  L(`    ${sp.padEnd(12)} 그래프 ${String(gh).padStart(2)}/${s.length}  (${pct(gh, s.length).padStart(4)})    BM25 ${String(bh).padStart(2)}/${s.length}  (${pct(bh, s.length).padStart(4)})`);
}

const withPerson = rows.filter((r) => rows.find((x) => x.id === r.id) && gold.items.find((i: any) => i.id === r.id)?.needPerson);
const ph = withPerson.filter((r) => r.personHit).length;
L(`\n  [ 사람까지 짚었는가 ] ${ph}/${withPerson.length} (${pct(ph, withPerson.length)})`);

L("\n  [ 거절이 정답인 문항 ]");
const oos = rows.filter((r) => REFUSE.includes(r.kind));
for (const r of oos) L(`    ${r.refused ? "✅ 거절" : `❌ 답하려 함 (${r.graphGot.length}편)`}   ${r.id}  ${r.question.slice(0, 34)}`);
L(`    ${oos.filter((r) => r.refused).length}/${oos.length} 정상 거절`);

L("\n  [ 그래프가 놓친 것 ]");
let missed = 0;
for (const r of scored) {
  if (r.graphHit) continue;
  missed++;
  L(`    [${r.id}] ${r.need}  — ${r.question.slice(0, 40)}`);
  L(`           근거→ ${r.graphGot.slice(0, 5).map(titleOf).join(", ")}`);
}
if (!missed) L("    (없음)");
L("\n" + "═".repeat(78));
