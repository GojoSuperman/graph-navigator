/**
 * 질문 → 경로 판정 + 씨앗 찾기.
 *
 * law-navigator 에서 가져온 두 가지 교훈이 여기 박혀 있다.
 *
 *  ① **거절은 점수로 못 만든다.** "점수가 낮으면 거절"을 시도했다가 실패했다 —
 *     범위 밖 질문이 범위 안 일상어 질문보다 점수가 높았다. 그래서 방향을 뒤집어
 *     **도메인 신호가 있을 때만 답한다.**
 *  ② **애매하면 넓은 쪽으로.** bridge 가 모으는 근거는 lookup 의 근거를 포함한다.
 */

import { BM25 } from "./bm25.ts";
import type { MovieGraph } from "./graph.ts";
import type { Route } from "./types.ts";
import { nameMatches } from "./romanize.ts";

/** 조회·탐색으로 답할 수 없는 것 — 답하지 않는 것이 정답이다 */
const OUT_OF_SCOPE = [
  "예매", "티켓", "상영관", "몇 시", "상영 시간표",
  "어디서 봐", "어디서 볼", "무료로 보", "다운로드", "토렌트", "자막 파일",
  "넷플릭스에 있", "왓챠에 있", "디즈니플러스에 있",
  "재밌을까", "재미있을까", "볼만할까", "평점 예측", "흥행할까",
];

/** 인물의 작품 목록을 묻는다 */
const FILMOGRAPHY_HINTS = [
  "무슨 영화", "어떤 영화", "영화 뭐", "작품 뭐", "필모", "출연작", "연출작",
  "나온 영화", "만든 영화", "감독한", "출연한 영화",
];

/** ★ 다리를 건너야 답이 되는 질문 — 이 프로젝트가 증명하려는 자리 */
const BRIDGE_HINTS = [
  "같이 나온", "함께 나온", "같이 출연", "함께 출연",
  "나온 배우가", "나왔던 배우", "그 배우가", "같은 배우",
  "다른 영화", "또 나온", "에도 나온", "에도 출연",
  "감독이 만든", "같은 감독", "그 감독",
];

/** 배역을 통해 배우를 묻는다 — "기택 역을 맡은 배우" */
const CHARACTER_HINTS = ["역을 맡", "역을 연기", "역의 배우", "역할을 맡", "로 나온", "역 배우", "을 연기한", "를 연기한"];

/** 비슷한 것을 찾는다 */
const SIMILAR_HINTS = ["비슷한", "같은 느낌", "추천", "볼 만한", "닮은"];

export interface RouteResult {
  route: Route;
  reason: string;
}

export function route(question: string): RouteResult {
  const q = question.replace(/\s+/g, "");
  const hit = (list: string[]) => list.find((h) => q.includes(h.replace(/\s+/g, "")));

  const oos = hit(OUT_OF_SCOPE);
  if (oos) return { route: "out_of_scope", reason: `조회로 답할 수 없는 주제: ${oos}` };

  const br = hit(BRIDGE_HINTS);
  if (br) return { route: "bridge", reason: `다리를 건너야 함: ${br}` };

  const fi = hit(FILMOGRAPHY_HINTS);
  if (fi) return { route: "filmography", reason: `작품 목록을 물음: ${fi}` };

  const ch = hit(CHARACTER_HINTS);
  if (ch) return { route: "lookup", reason: `배역으로 배우를 물음: ${ch}` };

  const si = hit(SIMILAR_HINTS);
  if (si) return { route: "similar", reason: `유사 작품을 물음: ${si}` };

  return { route: "lookup", reason: "특정 작품·인물의 정보로 본다" };
}

// ── 색인 (한 번 만들고 재사용) ─────────────────────────────────────────
let _idx: { g: MovieGraph; bm: BM25 } | null = null;
function indexOf(g: MovieGraph): BM25 {
  if (_idx && _idx.g === g) return _idx.bm;
  const bm = new BM25(
    [...g.movies.values()].map((m) => ({
      id: m.id,
      title: `${m.title} ${m.originalTitle}`,
      text: `${m.overview} ${m.genres.join(" ")}`,
    })),
  );
  _idx = { g, bm };
  return bm;
}

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/**
 * 제목이 질문 안에 그대로 들어 있는가.
 * **긴 제목부터** 맞춘다 — 《범죄도시 2》를 《범죄도시》로 잘못 끊지 않도록.
 * (law-navigator 에서 '개인정보처리자'가 '개인정보'에 먹히던 것과 같은 문제)
 */
export function seedsFromTitle(question: string, g: MovieGraph): string[] {
  const q = norm(question);
  return [...g.movies.values()]
    .filter((m) => m.title.length >= 2 && q.includes(norm(m.title)))
    .sort((a, b) => b.title.length - a.title.length || b.popularity - a.popularity)
    .slice(0, 3)
    .map((m) => m.id);
}

/** 질문에 인물 이름이 있으면 그 사람의 대표작을 씨앗으로 준다 */
export function seedsFromPerson(question: string, g: MovieGraph, top = 4): string[] {
  const q = norm(question);
  const hits = [...g.people.values()]
    .filter((p) => p.name.length >= 2 && q.includes(norm(p.name)))
    .sort((a, b) => b.name.length - a.name.length || b.popularity - a.popularity);
  if (!hits.length) return [];
  const films = g.filmsOf(hits[0].id)
    .map((e) => g.movie(e.to))
    .filter(Boolean)
    .sort((a, b) => b!.popularity - a!.popularity)
    .slice(0, top);
  return films.map((m) => m!.id);
}

/**
 * 배역명으로 작품을 찾는다.
 *
 * TMDB 는 배역명을 로마자로만 준다 — "기택" 이 "Kim Ki-taek" 으로 들어 있다.
 * 줄거리 텍스트에는 배우 이름도 배역 이름도 없으므로, **크레딧이라는 선을 건너지
 * 않으면 영원히 못 찾는다.** 이 프로젝트가 증명하려는 자리가 바로 여기다.
 */
/**
 * 질문에 늘 나오는 말은 배역 후보에서 뺀다.
 *
 * 실측으로 확인한 사고 — "배우" 가 로마자로 `bau` 가 되어 **온 세상 Paul** 과
 * 맞아 버렸다 (Paul, Paula, Paul Brodie, Paul Doyle …). "영화" 는 `Myeong-hwa`
 * 와 맞았다. 느슨한 대조는 이런 식으로 조용히 망가진다.
 */
const NOT_A_CHARACTER = new Set([
  "영화", "배우", "누구", "누구인", "누구인가", "누구인가요", "무엇", "무엇인",
  "역을", "역할", "역할을", "맡은", "맡았", "연기", "연기한", "출연", "출연한",
  "주연", "조연", "악역", "감독", "작품", "제목", "이름", "알려", "알려줘",
  "어떻게", "어떤", "무슨", "시리즈", "나오는", "나온",
]);

export function seedsFromCharacter(question: string, g: MovieGraph, top = 3): string[] {
  // 2~4글자 한글 덩어리를 배역 후보로 본다 (조사가 붙은 형태도 앞에서 잘라 본다)
  const cands = new Set<string>();
  for (const w of question.match(/[가-힣]{2,5}/g) ?? []) {
    for (const c of [w, w.slice(0, w.length - 1), w.slice(0, w.length - 2)]) {
      if (c.length >= 2 && !NOT_A_CHARACTER.has(c)) cands.add(c);
    }
  }
  const scored: { id: string; len: number; pop: number }[] = [];
  for (const m of g.movies.values()) {
    for (const e of g.creditsOf(m.id, "ACTED_IN")) {
      if (!e.as) continue;
      for (const c of cands) {
        if (c.length >= 2 && nameMatches(c, e.as)) {
          scored.push({ id: m.id, len: c.length, pop: m.popularity });
        }
      }
    }
  }
  // 긴 후보가 이긴다 — '마석도'가 '석도'에 먹히지 않도록
  return [...new Set(
    scored.sort((a, b) => b.len - a.len || b.pop - a.pop).map((x) => x.id),
  )].slice(0, top);
}

/** 장르 색인 — 법령의 '정의 용어 색인' 과 같은 자리 */
export function seedsFromGenre(question: string, g: MovieGraph, top = 3): string[] {
  const q = norm(question);
  const genre = Object.keys(g.genreIndex).find((name) => q.includes(norm(name)));
  return genre ? (g.genreIndex[genre] ?? []).slice(0, top) : [];
}

export function seedsFromKeywords(question: string, g: MovieGraph, top = 3): string[] {
  return indexOf(g).search(question, top).map((r) => r.id);
}

/**
 * 이 질문이 영화 이야기인가.
 *
 * law-navigator 에서 "음주운전 걸렸는데" 에 개인정보 조문 10건을 내놓았던 사고를
 * 반복하지 않으려는 장치다. BM25 는 **어떤 질문에든** 상위 N 개를 돌려주므로,
 * 점수만으로는 "모르는 주제"를 걸러낼 수 없다.
 */
export function domainSignal(question: string, g: MovieGraph): { ok: boolean; reason: string } {
  if (seedsFromTitle(question, g).length) return { ok: true, reason: "작품 제목을 지목했다" };
  if (seedsFromPerson(question, g).length) return { ok: true, reason: "인물 이름이 있다" };
  if (seedsFromGenre(question, g).length) return { ok: true, reason: "장르를 지목했다" };
  if (seedsFromCharacter(question, g).length) return { ok: true, reason: "배역명이 있다" };
  const q = norm(question);
  const word = ["영화", "배우", "감독", "출연", "작품", "주연", "개봉", "시리즈"].find((w) => q.includes(w));
  if (word) return { ok: true, reason: `영화 이야기의 말: ${word}` };
  return { ok: false, reason: "영화 이야기인지 알 수 없습니다" };
}

/**
 * 씨앗 찾기.
 *
 * **제목을 명시했으면 그것만 쓴다.** law-navigator 에서 "질문에 조문 번호가 적혀
 * 있으면 그것만" 으로 했던 것과 같은 규칙이다. 실측에서 확인한 문제 —
 * "부산행에 나온 배우가…" 에 BM25 가 《서복》·《지옥이 뭐가 나빠》를 씨앗으로 끼워
 * 넣었고, 그 잡음이 예산을 나눠 먹어 정작 부산행에서 뻗어야 할 다리가 밀렸다.
 *
 * 그 외에는 인물 → 장르 → 키워드 순으로 넓혀 간다. 확실한 것을 앞에 둔다.
 */
export function findSeeds(question: string, g: MovieGraph, top = 3): string[] {
  if (!domainSignal(question, g).ok) return [];

  const titles = seedsFromTitle(question, g);
  const people = seedsFromPerson(question, g);
  const chars = seedsFromCharacter(question, g);

  // 제목·배역은 확실한 단서다. 하나라도 잡히면 거기서 출발하고 BM25 는 부르지 않는다.
  if (titles.length || chars.length) return [...new Set([...titles, ...chars, ...people])];

  return [...new Set([...people, ...seedsFromGenre(question, g), ...seedsFromKeywords(question, g, top)])];
}

/** 근거가 없으면 LLM 을 부르지 않는다 (law-navigator §7-1 과 같은 자리) */
export function canAnswer(r: RouteResult, seeds: string[], evidenceCount: number) {
  if (r.route === "out_of_scope") return { ok: false as const, reason: r.reason };
  if (!seeds.length) {
    return { ok: false as const, reason: "이 도구는 수집한 영화 목록 안에서만 답합니다. 질문에서 작품·인물을 찾지 못했습니다." };
  }
  if (evidenceCount === 0) return { ok: false as const, reason: "근거로 쓸 작품이 없습니다" };
  return { ok: true as const };
}
