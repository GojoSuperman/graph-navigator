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
import { detectFollowUp } from "./followup.ts";
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
  /** 개봉일 `YYYY-MM-DD` — 연도만으로는 "개봉일은?" 에 답할 수 없다 */
  releaseDate: string | null;
  overview: string;
  genres: string[];
  voteAverage: number;
  korean: boolean;
  posterPath: string | null;
  awards: { award: string; year: number | null }[];
  path: PathStep[];
  isSeed: boolean;
  /**
   * 이 작품의 감독과 주연 몇 명.
   *
   * 없을 때 실제로 난 일 — 근거에 《극한직업》이 들어와 있는데도
   * "류승룡 이름 자체가 근거에 없습니다" 라고 답했다. 줄거리에는 배우가
   * 안 적혀 있으므로, **크레딧을 같이 싣지 않으면 근거가 사람을 말하지 못한다.**
   * 질문이 준 두 번째 조건(감독·배역)을 확인하는 데도 이것이 필요하다.
   */
  credits: { name: string; as: string | null; role: "출연" | "감독" | "각본" }[];
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
  /**
   * 작품 교집합의 공통 참여자.
   * `role` 은 **그 작품들에서 실제로 맡은 것**이다 — "제작진" 이라고만 적었더니
   * "공통 감독은?" 에 "근거에 감독 정보가 없다" 고 답하는 사고가 났다.
   */
  commonPeople: { name: string; acted: boolean; role: string }[];
  /** 인물 교집합의 공통 작품 */
  commonMovies: { id: string; title: string; year: number | null }[];
  /**
   * 출연진 — "이 영화에 누가 나와?" 의 답. 사람 목록이다.
   *
   * `movie` 는 **동명이작일 때만** 채운다. 어느 《괴물》의 출연진인지 밝히지 않으면
   * 목록만 보고는 구분할 수 없기 때문이다. 한 편뿐이면 비워 두어 화면이 조용하다.
   */
  cast: {
    id: string; name: string; as: string | null; role: "출연" | "감독" | "각본";
    movie?: { id: string; title: string; year: number | null; director: string | null };
  }[];
  /** 질문이 가리킨 인물 — 별칭으로 찾았으면 실제 이름이 다를 수 있다 */
  matchedPeople: { name: string; aliases: string[] }[];
  /** 질문에 이름이 나온 사람의 수상 */
  personAwards: { person: string; award: string; year: number | null; forTitle: string | null }[];
  evidence: EvidenceMovie[];
  dropped: number;
  /** 직전 결과를 물려받아 거른 경우 — 무엇을 걸렀는지 */
  followUp: { of: string; filters: string[] } | null;
  /** 이어붙이려다 포기한 경우 그 이유 */
  followUpGaveUp: string | null;
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

/**
 * 근거에 실을 크레딧 — 감독·각본을 먼저, 그다음 주연 순.
 *
 * 수를 제한하는 이유는 근거 예산과 같다. 한 작품에 30명이 붙어 있어서
 * 전부 실으면 근거 10편이 조연 이름으로 뒤덮여 정작 작품이 밀린다.
 */
const CREDITS_PER_MOVIE = 5;
const creditsFor = (g: MovieGraph, id: string): EvidenceMovie["credits"] => {
  const rank = (e: { kind: string; order?: number }) =>
    e.kind === "DIRECTED" ? -2 : e.kind === "WROTE" ? -1 : (e.order ?? 99);
  return g.creditsOf(id)
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, CREDITS_PER_MOVIE)
    .flatMap((e) => {
      const p = g.person(e.from);
      if (!p) return [];
      return [{
        name: p.name,
        as: e.as ?? null,
        role: (e.kind === "DIRECTED" ? "감독" : e.kind === "WROTE" ? "각본" : "출연") as "출연" | "감독" | "각본",
      }];
    });
};

const toEvidence = (g: MovieGraph, m: Movie, path: Hop[], isSeed: boolean): EvidenceMovie => ({
  id: m.id,
  credits: creditsFor(g, m.id),
  title: m.title,
  year: m.year,
  releaseDate: m.releaseDate ?? null,
  overview: m.overview,
  genres: m.genres,
  voteAverage: m.voteAverage,
  korean: m.originalLanguage === "ko",
  posterPath: m.posterPath ?? null,
  awards: m.awards ?? [],
  path: toSteps(g, path),
  isSeed,
});

/** 직전 결과 — 이어지는 질문이 물려받는다 */
export interface Previous { question: string; movieIds: string[] }

export function ask(g: MovieGraph, question: string, previous?: Previous): AskResult {
  // ── 이어지는 질문이면 새로 찾지 않고 직전 근거를 거른다 ────────────
  const fu = detectFollowUp(question, Boolean(previous?.movieIds.length));
  if (fu.isFollowUp && previous) {
    let ms = previous.movieIds.map((id) => g.movie(id)!).filter(Boolean);
    for (const f of fu.filters) ms = f.apply(ms);
    return {
      question,
      route: "lookup",
      reason: `직전 결과를 이어받음 — ${fu.filters.map((f) => f.label).join(" · ")}`,
      refused: false,
      refusalReason: null,
      premiseBroken: ms.length === 0,
      premiseReason: ms.length === 0
        ? `직전 결과 ${previous.movieIds.length}편 중 **${fu.filters.map((f) => f.label).join(" · ")}** 에 해당하는 작품이 없습니다`
        : null,
      premiseInstead: null,
      seeds: [],
      cast: [],
      matchedPeople: [],
      characters: [],
      commonPeople: [],
      commonMovies: [],
      personAwards: [],
      evidence: ms.map((m) => toEvidence(g, m, [], false)),
      dropped: 0,
      followUp: { of: previous.question, filters: fu.filters.map((f) => f.label) },
      followUpGaveUp: null,
    };
  }

  return askFresh(g, question, fu.gaveUp);
}

function askFresh(g: MovieGraph, question: string, gaveUp: string | null): AskResult {
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
      cast: [], matchedPeople: [], characters: [], commonPeople: [], commonMovies: [], personAwards: [],
      evidence: [], dropped: 0, followUp: null, followUpGaveUp: gaveUp,
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

  /**
   * 출연진 목록.
   *
   * 답이 **사람**이므로 영화 목록으로는 답이 되지 않는다. 실측 사고 —
   * "괴물에 나온 배우들 알려줘" 가 봉준호의 다른 영화 9편을 내놓았다.
   * 질문이 지목한 작품의 크레딧을 그대로 돌려준다.
   */
  const cast: AskResult["cast"] = [];
  if (r.route === "cast") {
    /**
     * 동명이작이면 **고르지 않는다.**
     *
     * 실측 — "괴물에 나온 배우들 알려줘" 에 안도 사쿠라·쿠로카와 소야… 가 나왔다.
     * 말뭉치에 《괴물》이 둘 있다 — 봉준호(2006, 투표 3,239)와 고레에다(2023, 투표 957).
     * 여기서 `titlesIn(...)[0]` 이 한 편을 골랐고, 그 순서를 정한 것이 **인기**다.
     * 인기는 최근작에 유리한 지표라 2023 이 이겼다. 투표수로 바꿔도 안 된다 —
     * 한국·외국이 섞인 동명이작 12개 중 8개에서 여전히 외국 작품이 이긴다.
     *
     * 애초에 **고를 근거가 질문에 없다.** 사람이 그냥 "괴물" 이라고 했으면
     * 사람도 어느 쪽인지 모른다. 그래서 둘 다 싣고 **어느 작품인지 밝힌다** —
     * 이 프로젝트가 '답을 지어내지 않는다' 고 한 것과 같은 자리다.
     */
    const first = titlesIn(question, g)[0] ?? g.movie(seeds[0] ?? "");
    const targets = first
      ? [...g.movies.values()]
          .filter((m) => m.title === first.title)
          /**
           * 순서는 **한국 작품 먼저**, 그다음 투표수. 배열 순서에 기대면
           * 수집 순서가 바뀔 때 조용히 뒤집힌다. 한국 영화를 앞에 두는 것은
           * 이 도구가 한국 영화 내비게이터이고, 외국 작품은 인물을 따라
           * 1홉 확장으로 들어온 **다리**이기 때문이다 (README 수집 범위 참고).
           */
          .sort((a, b) =>
            (a.originalLanguage === "ko" ? 0 : 1) - (b.originalLanguage === "ko" ? 0 : 1) ||
            b.voteCount - a.voteCount)
          .slice(0, 3)
      : [];
    const many = targets.length > 1;
    // 여러 편이면 한 편당 줄 수를 줄인다 — 근거 블록이 두 배로 부풀지 않도록
    const per = many ? 12 : 25;
    for (const target of targets) {
      const rank = (e: { kind: string; order?: number }) =>
        e.kind === "DIRECTED" ? -2 : e.kind === "WROTE" ? -1 : (e.order ?? 99);
      const credits = g.creditsOf(target.id).sort((a, b) => rank(a) - rank(b));
      const director = credits.find((e) => e.kind === "DIRECTED");
      const label = many
        ? {
            id: target.id, title: target.title, year: target.year,
            director: director ? (g.person(director.from)?.name ?? null) : null,
          }
        : undefined;
      for (const e of credits.slice(0, per)) {
        const p = g.person(e.from);
        if (!p) continue;
        cast.push({
          id: p.id, name: p.name, as: e.as ?? null,
          role: e.kind === "DIRECTED" ? "감독" : e.kind === "WROTE" ? "각본" : "출연",
          ...(label ? { movie: label } : {}),
        });
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
  // peopleIn 을 쓴다 — 별칭 판정이 여기만 빠지면 "아이유 수상" 이 안 잡힌다
  for (const p of peopleIn(question, g)) {
    if (!p.awards?.length) continue;
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
    cast,
    matchedPeople: ps.map((p) => ({ name: p.name, aliases: p.aliases ?? [] })),
    characters: [...new Map(characters.map((c) => [`${c.person}|${c.movie}`, c])).values()].slice(0, 6),
    commonPeople: cp.people.map((p) => {
      const kinds = new Set(
        cp.movies.flatMap((mid) => g.creditsOf(mid).filter((e) => e.from === p.id).map((e) => e.kind)),
      );
      const role = [...kinds]
        .map((k) => (k === "DIRECTED" ? "감독" : k === "WROTE" ? "각본" : "출연"))
        .join("·");
      return { name: p.name, acted: p.acted !== false, role: role || "참여" };
    }),
    commonMovies: shared,
    personAwards: personAwards.slice(0, 8),
    evidence: got.movies.map((m) =>
      toEvidence(g, m, got.paths.get(m.id)?.length ? got.paths.get(m.id)! : (bridges.get(m.id) ?? []), seedSet.has(m.id)),
    ),
    dropped: got.dropped,
    followUp: null,
    followUpGaveUp: gaveUp,
  };
}

export { describePath };
