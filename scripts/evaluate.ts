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
import { route, findSeeds, canAnswer, commonPeople, checkPremise } from "../lib/route.ts";
import { ask } from "../lib/ask.ts";
import { nameMatches } from "../lib/romanize.ts";

const DATA = join(import.meta.dirname, "..", "data");
const g = new MovieGraph(JSON.parse(await readFile(join(DATA, "graph.json"), "utf-8")));
const gold = JSON.parse(await readFile(join(DATA, "golden.json"), "utf-8"));

// 비교군은 **같은 토크나이저**를 써야 공정하다
const bm25 = new BM25(
  [...g.movies.values()].map((m) => ({ id: m.id, title: `${m.title} ${m.originalTitle}`, text: `${m.overview} ${m.genres.join(" ")}` })),
);

// 채점에서 빼는 유형 — 기준 작품을 데려오는 것이 목표가 아닌 문항들
const REFUSE = ["out_of_scope", "no-answer", "verify-claim", "ranking"];
const titleOf = (id: string) => g.movie(id)?.title ?? id;

type Row = {
  id: string; kind: string; split: string; question: string;
  need: string[]; answer: string;
  route: string; refused: boolean; premiseBroken: boolean;
  graphHit: boolean; bm25Hit: boolean; personHit: boolean;
  graphGot: string[];
};

/**
 * 기준 작품이 근거에 들어왔는가.
 * 정답이 여럿일 수 있으므로(교집합 질문) **하나라도** 들어오면 맞은 것으로 친다.
 */
const hasMovie = (ids: string[], titles: string[]) =>
  titles.some((title) =>
    ids.some((id) => {
      const t = g.movie(id)?.title ?? "";
      return t === title || t.startsWith(title) || title.startsWith(t);
    }),
  );

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
    if (!personHit && q.kind === "cast") {
      const r2 = ask(g, q.question);
      if (r2.cast.some((c) => c.name === q.needPerson)) personHit = true;
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
    need: q.needMovies ?? [], answer: q.answer,
    route: r.route, refused: !gate.ok,
    premiseBroken: checkPremise(q.question, g).broken,
    graphHit: (q.needMovies ?? []).length ? hasMovie(graphGot, q.needMovies) : false,
    bm25Hit: (q.needMovies ?? []).length ? hasMovie(bm25Got, q.needMovies) : false,
    personHit,
    graphGot,
  });
}

const L = (s = "") => console.log(s);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : "—");

L("═".repeat(78));
L(`  컨텍스트 재현율 — 그래프 탐색 vs BM25   (근거 예산 ${DEFAULT_BUDGET.maxMovies}편)`);
L("═".repeat(78));

const scored = rows.filter((r) => !REFUSE.includes(r.kind) && r.need.length);
L("\n  문항   유형          기대작품          그래프 BM25  라우팅");
L("  " + "─".repeat(70));
let last = "";
for (const r of scored) {
  if (r.split !== last) { L(`  ── ${gold.splits[r.split] ? r.split : r.split} ${"─".repeat(46)}`); last = r.split; }
  const mark = r.graphHit && !r.bm25Hit ? "▲" : !r.graphHit && r.bm25Hit ? "▼" : " ";
  L(`  ${mark} ${r.id.padEnd(5)} ${r.kind.padEnd(12)} ${r.need.join("/").slice(0, 14).padEnd(16)} ${(r.graphHit ? " ✅" : " ❌").padEnd(5)} ${(r.bm25Hit ? "✅" : "❌").padEnd(5)} ${r.route}`);
}

L("\n  [ 유형별 — 기준 작품을 근거로 데려왔는가 ]");
for (const kind of ["character", "cast", "filmography", "bridge", "intersect-movie", "intersect-person", "award", "release", "content"]) {
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

L("\n  [ 거절이 정답인 문항 — 이 도구의 범위 밖 ]");
const oos = rows.filter((r) => r.kind === "out_of_scope");
for (const r of oos) L(`    ${r.refused ? "✅ 거절" : `❌ 답하려 함 (${r.graphGot.length}편)`}   ${r.id}  ${r.question.slice(0, 34)}`);
L(`    ${oos.filter((r) => r.refused).length}/${oos.length} 정상 거절`);

// ── 전제가 무너진 질문 ────────────────────────────────────────────────
//
// "추격자·황해·곡성에 모두 출연한 배우는?" — 그런 배우가 **없다**.
// 근거를 늘어놓으면 답하지 않으면서 답하는 척하는 것이 된다.
// 거절과는 다르다. 이쪽은 **찾아본 결과**이므로 더 강한 주장이다.
// ── 참/거짓 판별 ──────────────────────────────────────────────────────
// "A는 X·Y·Z에 모두 출연했다" — 틀린 전제가 섞여 있다. 지어내지 않는지를 본다.
const vc = gold.items.filter((i: any) => i.kind === "verify-claim");
if (vc.length) {
  L("\n  [ 참/거짓 판별 — 틀린 전제를 알아보는가 ]");
  let ok = 0;
  for (const it of vc) {
    const cp = commonPeople(it.question, g);
    const inAll = cp.people.some((p) => p.name === it.needPerson && p.acted !== false);
    const said = inAll;                      // 시스템의 판단
    const truth = it.claimTrue as boolean;   // 실제
    if (said === truth) ok++;
    else L(`    ❌ ${it.id} ${it.needPerson} — 실제 ${truth ? "맞다" : "아니다"} / 시스템 ${said ? "맞다" : "아니다"}`);
  }
  L(`    ${ok}/${vc.length} 정확`);
}

const na = rows.filter((r) => r.kind === "no-answer");
if (na.length) {
  L("\n  [ 전제가 사실이 아닌 문항 — '그런 배우는 없습니다' 가 정답 ]");
  for (const r of na) {
    L(`    ${r.premiseBroken ? "✅ 없다고 말함" : `❌ 답하려 함 (${r.graphGot.length}편)`}   ${r.id}  ${r.question.slice(0, 40)}`);
  }
  L(`    ${na.filter((r) => r.premiseBroken).length}/${na.length} 정상`);
}

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
