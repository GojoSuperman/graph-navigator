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
import { route, findSeeds, canAnswer, seedsFromCharacter, commonPeople, peopleIn, titlesIn, seedsFromPeopleIntersection, mentions, checkPremise } from "../lib/route.ts";
import { nameMatches } from "../lib/romanize.ts";

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
// ── 배역 → 배우 ────────────────────────────────────────────────────
// "기택 역을 맡은 배우는?" 의 답은 **영화가 아니라 사람**이다.
// 근거 목록만 내놓으면 질문에 답하지 않은 것이다.
const words = (q.match(/[가-힣]{2,5}/g) ?? []).flatMap((w) => [w, w.slice(0, -1)]);
const found: string[] = [];
for (const m of got.movies) {
  for (const e of g.creditsOf(m.id, "ACTED_IN")) {
    if (!e.as) continue;
    for (const w of words) {
      if (w.length >= 2 && nameMatches(w, e.as)) {
        const p = g.person(e.from);
        if (p) found.push(`  ▶ ${p.name}  —  《${m.title}》 ${e.as} 역`);
      }
    }
  }
}
// ── 전제 검사 ──────────────────────────────────────────────────────
// 찾아봤는데 전제가 사실이 아니면, 근거를 늘어놓는 대신 그렇다고 말한다.
const premise = checkPremise(q, g);
if (premise.broken) {
  L(`🚫 ${premise.reason}`);
  if (premise.instead) L(`   ${premise.instead}`);
  L(`   찾아본 결과이지 범위 밖이라는 뜻은 아닙니다.`);
  L("─".repeat(72));
  L();
  process.exit(0);
}

// ── 교집합 답 ──────────────────────────────────────────────────────
const cp = commonPeople(q, g);
if (cp.people.length) {
  L(`${titlesIn(q, g).slice(0, 4).map((m) => `《${m.title}》`).join(" ")} 에 모두 참여:`);
  for (const p of cp.people) L(`  ▶ ${p.name}${p.acted === false ? " (출연 아님 — 제작진)" : ""}`);
  L();
}
// 인물 교집합 — 탐색 결과가 아니라 **실제로 겹치는 작품**만 보여 준다
const ps = peopleIn(q, g);
if (ps.length >= 2) {
  const shared = seedsFromPeopleIntersection(q, g, 6).map((id) => g.movie(id)!).filter(Boolean);
  if (shared.length) {
    L(`${ps.slice(0, 3).map((p) => p.name).join(" · ")} 가 함께 나온 작품:`);
    for (const m of shared) L(`  ▶ 《${m.title}》${m.year ? ` (${m.year})` : ""}`);
    L();
  }
}

// 인물 수상 — 질문에 이름이 있으면 그 사람이 받은 상도 보여 준다
for (const p of g.people.values()) {
  if (p.name.length < 2 || !mentions(q, p.name) || !p.awards?.length) continue;
  const withWork = p.awards.filter((a: any) => a.forTitle);
  if (!withWork.length) continue;
  L(`${p.name} 수상:`);
  for (const a of withWork.slice(0, 6)) L(`  🏆 ${a.award}${a.year ? ` (${a.year})` : ""} — 《${a.forTitle}》`);
  L();
}

if (found.length) {
  L("찾은 배역:");
  for (const f of [...new Set(found)].slice(0, 5)) L(f);
  L();
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
  if (m.awards?.length) {
    L(`      🏆 ${m.awards.slice(0, 4).map((a) => `${a.award}${a.year ? ` (${a.year})` : ""}`).join(" · ")}`);
  }
  L(`      ${m.overview.replace(/\s+/g, " ").slice(0, 80)}…`);
  L();
}
L("─".repeat(72)); L();
