/**
 * 질문 하나 → 라우팅 → 씨앗 → 탐색 → 답 조립.
 *
 * **LLM 호출이 없다.** 답변 문장 생성은 app/api/ask 가 맡고, 여기까지는 순수 함수로
 * 남긴다 — 무엇을 근거로 데려왔는지를 모델 없이(비용 0, 결정적으로) 검증할 수 있어야 한다.
 * law-navigator 에서 가장 값어치 있었던 설계다.
 */

import { MovieGraph, collectEvidence, DEFAULT_BUDGET, describePath, type Hop } from "./graph.ts";
import {
  route as routeOf, findSeeds, canAnswer, checkPremise,
  commonPeople, peopleIn, titlesIn, seedsFromPeopleIntersection, mentions,
} from "./route.ts";
import { nameMatches } from "./romanize.ts";
import type { Movie, Route } from "./types.ts";

export interface PathStep {
  from: string;
  to: string;
  /** 이 홉을 건넌 사람 — 다리의 정체 */
  via: string;
  fromLabel: string;
  toLabel: string;
}

export interface EvidenceMovie {
  id: string;
  title: string;
  year: number | null;
  overview: string;
  genres: string[];
  voteAverage: number;
  korean: boolean;
  awards: { award: string; year: number | null }[];
  path: PathStep[];
  isSeed: boolean;
}

export interface AskResult {
  question: string;
  route: Route;
  reason: string;
  refused: boolean;
  refusalReason: string | null;
  /** 찾아봤더니 전제가 사실이 아닌 경우 — 거절과 다르다 */
  premiseBroken: boolean;
  premiseReason: string | null;
  premiseInstead: string | null;
  seeds: { id: string; title: string }[];
  /** 배역으로 찾은 사람 — "기택 역을 맡은 배우는?" 의 실제 답 */
  characters: { person: string; movie: string; as: string }[];
  /** 작품 교집합의 공통 참여자 */
  commonPeople: { name: string; acted: boolean }[];
  /** 인물 교집합의 공통 작품 */
  commonMovies: { id: string; title: string; year: number | null }[];
  /** 질문에 이름이 나온 사람의 수상 */
  personAwards: { person: string; award: string; year: number | null; forTitle: string | null }[];
  evidence: EvidenceMovie[];
  dropped: number;
}

const toSteps = (g: MovieGraph, path: Hop[]): PathStep[] =>
  path.map((h) => ({
    from: h.from,
    to: h.to,
    via: h.via ?? "",
    fromLabel: g.movie(h.from)?.title ?? h.from,
    toLabel: g.movie(h.to)?.title ?? h.to,
  }));

const toEvidence = (g: MovieGraph, m: Movie, path: Hop[], isSeed: boolean): EvidenceMovie => ({
  id: m.id,
  title: m.title,
  year: m.year,
  overview: m.overview,
  genres: m.genres,
  voteAverage: m.voteAverage,
  korean: m.originalLanguage === "ko",
  awards: m.awards ?? [],
  path: toSteps(g, path),
  isSeed,
});

export function ask(g: MovieGraph, question: string): AskResult {
  const r = routeOf(question);
  const seeds = findSeeds(question, g);
  const premise = checkPremise(question, g);

  const base = {
    question,
    route: r.route,
    reason: r.reason,
    seeds: seeds.flatMap((id) => {
      const m = g.movie(id);
      return m ? [{ id, title: m.title }] : [];
    }),
  };

  // 범위 밖 — 아무것도 모으지 않는다
  if (r.route === "out_of_scope") {
    return {
      ...base, refused: true, refusalReason: r.reason,
      premiseBroken: false, premiseReason: null, premiseInstead: null,
      characters: [], commonPeople: [], commonMovies: [], personAwards: [],
      evidence: [], dropped: 0,
    };
  }

  const got = collectEvidence(g, seeds, DEFAULT_BUDGET, r.route);
  const gate = canAnswer(r, seeds, got.movies.length);
  const seedSet = new Set(seeds);

  // ── 배역 → 배우 ────────────────────────────────────────────────────
  // "기택 역을 맡은 배우는?" 의 답은 영화가 아니라 **사람**이다.
  const words = (question.match(/[가-힣]{2,5}/g) ?? []).flatMap((w) => [w, w.slice(0, -1)]);
  const characters: AskResult["characters"] = [];
  const scope = titlesIn(question, g).length ? titlesIn(question, g).map((m) => m.id) : got.movies.map((m) => m.id);
  for (const id of scope) {
    const m = g.movie(id);
    if (!m) continue;
    for (const e of g.creditsOf(id, "ACTED_IN")) {
      if (!e.as) continue;
      for (const w of words) {
        if (w.length >= 2 && nameMatches(w, e.as)) {
          const p = g.person(e.from);
          if (p) characters.push({ person: p.name, movie: m.title, as: e.as });
        }
      }
    }
  }

  const cp = commonPeople(question, g);
  const ps = peopleIn(question, g);
  const shared = ps.length >= 2
    ? seedsFromPeopleIntersection(question, g, 6).flatMap((id) => {
        const m = g.movie(id);
        return m ? [{ id, title: m.title, year: m.year }] : [];
      })
    : [];

  const personAwards: AskResult["personAwards"] = [];
  for (const p of g.people.values()) {
    if (p.name.length < 2 || !mentions(question, p.name) || !p.awards?.length) continue;
    for (const a of p.awards.filter((x) => x.forTitle).slice(0, 6)) {
      personAwards.push({ person: p.name, award: a.award, year: a.year, forTitle: a.forTitle });
    }
  }

  return {
    ...base,
    refused: !gate.ok,
    refusalReason: gate.ok ? null : gate.reason,
    premiseBroken: premise.broken,
    premiseReason: premise.broken ? premise.reason : null,
    premiseInstead: premise.instead ?? null,
    characters: [...new Map(characters.map((c) => [`${c.person}|${c.movie}`, c])).values()].slice(0, 6),
    commonPeople: cp.people.map((p) => ({ name: p.name, acted: p.acted !== false })),
    commonMovies: shared,
    personAwards: personAwards.slice(0, 8),
    evidence: got.movies.map((m) => toEvidence(g, m, got.paths.get(m.id) ?? [], seedSet.has(m.id))),
    dropped: got.dropped,
  };
}

export { describePath };
