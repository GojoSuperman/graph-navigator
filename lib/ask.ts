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

/**
 * 씨앗끼리의 다리를 찾는다.
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────
 * "마동석이 이터널스 이전에 찍은 좀비 영화는?" 에서 씨앗이 7개 나왔다 —
 * 이터널스와 **마동석의 출연작 전부**가 한꺼번에 들어온 것이다.
 * 씨앗은 탐색으로 도달한 것이 아니므로 경로가 비어 있고, 그래서 화면에
 * **정작 답인 《부산행》으로 가는 다리가 그려지지 않았다.**
 * 엉뚱한 배우(젬마 찬·안젤리나 졸리)로 건너간 선만 보였다.
 *
 * 그런데 이터널스와 부산행은 **그래프에서 분명히 이어져 있다** — 마동석으로.
 * 씨앗 찾기가 지름길을 타면서 탐색 단계를 건너뛰었을 뿐이다.
 * 도달 방법이 무엇이었든 **관계가 있으면 그 관계를 보여 주는 것이 옳다.**
 *
 * 질문에 이름이 나온 인물을 우선한다. 그 사람이 질문의 주인공이기 때문이다.
 */
function seedBridges(g: MovieGraph, seeds: string[], question: string): Map<string, Hop[]> {
  const out = new Map<string, Hop[]>();
  if (seeds.length < 2) return out;

  // 기준점 — 질문이 제목으로 지목한 작품, 없으면 첫 씨앗
  const named = new Set(titlesIn(question, g).map((m) => m.id));
  const anchor = seeds.find((id) => named.has(id)) ?? seeds[0];

  const asked = new Set(peopleIn(question, g).map((p) => p.id));
  const creditsOf = (id: string) =>
    new Map(g.creditsOf(id).map((e) => [e.from, e] as const));
  const anchorCredits = creditsOf(anchor);

  for (const id of seeds) {
    if (id === anchor) continue;
    const here = creditsOf(id);
    const shared = [...here.keys()].filter((pid) => anchorCredits.has(pid));
    if (!shared.length) continue;
    // 질문에 나온 사람 > 주연에 가까운 사람
    const pick =
      shared.find((pid) => asked.has(pid)) ??
      shared.sort((a, b) => (here.get(a)!.order ?? 99) - (here.get(b)!.order ?? 99))[0];
    const p = g.person(pick);
    if (!p) continue;
    out.set(id, [{ from: anchor, to: id, kind: here.get(pick)!.kind, via: p.name }]);
  }
  return out;
}

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
  // 씨앗끼리도 관계가 있으면 그려 준다 (탐색으로 도달하지 않았을 뿐이다)
  const bridges = seedBridges(g, seeds, question);
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
    evidence: got.movies.map((m) =>
      toEvidence(g, m, got.paths.get(m.id)?.length ? got.paths.get(m.id)! : (bridges.get(m.id) ?? []), seedSet.has(m.id)),
    ),
    dropped: got.dropped,
  };
}

export { describePath };
