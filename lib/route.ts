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
import type { Movie, Person, Route } from "./types.ts";
import STATS from "../data/stats.json" with { type: "json" };
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
  "와 함께", "과 함께", "함께 출연", "함께 주연", "같이 출연", "모두 출연", "자주 출연",
  // 배역 → 배우 → 다른 작품. 세 단계이고, 가운데 배우 이름이 질문에 없다.
  "연기한 배우가", "맡은 배우가", "역의 배우가", "배우가 출연한", "배우가 주연",
  "같이 나온", "함께 나온", "같이 출연", "함께 출연",
  "나온 배우가", "나왔던 배우", "그 배우가", "같은 배우",
  "다른 영화", "또 나온", "에도 나온", "에도 출연",
  "감독이 만든", "같은 감독", "그 감독",
];

/**
 * 수상을 묻는다.
 *
 * TMDB 에 수상 정보가 없어서 위키데이터를 따로 붙였다. 경로를 나눠 두는 이유는
 * **모으는 근거가 다르기 때문**이다 — 수상 질문은 작품의 줄거리가 아니라
 * 수상 기록이 근거다. 법령판에서 벌칙 경로를 따로 둔 것과 같은 판단이다.
 */
const AWARD_HINTS = [
  "황금종려", "칸 영화제", "베를린", "베니스", "아카데미", "오스카",
  "청룡", "대종상", "백상", "골든글로브", "수상", "상을 받", "상 받",
  "여우주연", "남우주연", "감독상", "작품상", "각본상", "황금곰", "은곰",
];

/**
 * 이 작품에 **누가 나오는지** 묻는다.
 *
 * 배역 질문("기택 역을 맡은 배우")과 다르다. 저쪽은 한 사람을 찾는 것이고,
 * 이쪽은 **목록**을 달라는 것이다. 실측으로 잡은 사고 —
 * "괴물에 나온 배우들 알려줘" 가 lookup 으로 빠져서 봉준호의 다른 영화 9편을 내놓았다.
 * 답이 크레딧 안에 있는데 밖으로 건너가 버린 것이다.
 */
const CAST_HINTS = [
  "누가 나와", "누가 나오", "누가 출연", "나온 배우들", "나오는 배우들",
  "출연진", "출연자", "캐스팅", "배우들 알려", "배우들은", "배우 목록",
  "출연한 배우들", "누가 주연", "주연이 누구", "감독이 누구", "누가 만들",
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

  // 수상을 filmography 보다 먼저 본다. "출연한 영화 중 황금종려상을 받은 작품" 에서
  // '출연한 영화' 가 먼저 걸리면 근거를 엉뚱하게 모은다 — 더 좁은 단서가 이겨야 한다.
  const aw = hit(AWARD_HINTS);
  if (aw) return { route: "award", reason: `수상을 물음: ${aw}` };

  const fi = hit(FILMOGRAPHY_HINTS);
  if (fi) return { route: "filmography", reason: `작품 목록을 물음: ${fi}` };

  // 배역 질문보다 먼저 본다 — "나온 배우들" 은 목록이지 한 사람이 아니다
  const ca = hit(CAST_HINTS);
  if (ca) return { route: "cast", reason: `출연진을 물음: ${ca}` };

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
 * 질문이 이 이름을 말했는가.
 *
 * ⚠️ 공백을 지우고 부분 문자열로 보면 조용히 망가진다. 실측으로 잡은 사고:
 *   "기생충**에서 기**택" → `서기` (배우 서기)
 *   "한**국형** 좀비"     → `국형`
 *
 * 한국어에서 이름·제목은 **어절의 앞**에 오고 뒤에 조사가 붙는다
 * ("송강호**와**", "기생충**에서**"). 그래서 어절 시작에서만 맞춘다.
 * 어절 중간에서 시작하는 일치는 우연이다.
 */
/**
 * 어절이 **그 낱말로 끝나는가** (조사는 붙어도 된다).
 * mentions 는 시작만 보므로 '아이' 가 '아이유가' 에 걸린다. 부제를 뗀 짧은
 * 본 제목처럼 **짧고 흔한 것**을 찾을 때는 끝도 봐야 한다.
 */
const PARTICLES = /^(은|는|이|가|을|를|와|과|의|에|에서|에게|로|으로|도|만|요|야|이란|란|이라는|라는|인데|부터|까지)?$/;
export function mentionsWhole(question: string, name: string): boolean {
  const n = norm(name);
  if (n.length < 2) return false;
  return question.split(/\s+/).some((raw) => {
    // 구두점은 **가운데 것도** 턴다. 앞뒤만 털었더니 《버닝》에서 의 '》' 가 남아
    // "버닝》에서" 가 되고, 조사 판정이 깨져 두 글자 제목을 통째로 놓쳤다.
    const t = norm(raw.replace(/[^0-9A-Za-z가-힣]+/g, ""));
    return t.startsWith(n) && PARTICLES.test(t.slice(n.length));
  });
}

/**
 * 두 글자짜리는 **끝까지 봐야 한다.**
 * 실측 — 말뭉치가 커지며 《아이》(2022)가 들어오자 "**아이**유가 나온 영화" 에 걸렸다.
 * 세 글자 이상은 우연히 남의 낱말 앞부분이 되는 일이 드물어 지금 규칙을 둔다.
 */
const mentionsName = (question: string, name: string) =>
  norm(name).length <= 2 ? mentionsWhole(question, name) : mentions(question, name);

/** 부제를 뗀 본 제목. "지슬: 끝나지 않은 세월 2" → "지슬" */
const mainTitle = (t: string) => {
  const m = t.split(/\s*[:：]\s*| - /)[0].trim();
  return m.length >= 2 && m.length < t.length ? m : "";
};

export function mentions(question: string, name: string): boolean {
  const n = norm(name);
  if (n.length < 2) return false;

  const toks = question.split(/\s+/).map((raw) => norm(raw.replace(/^[^0-9A-Za-z가-힣]+/, "")));

  // 한 어절 안에서 시작하는 경우 — "송강호와", "기생충에서"
  if (toks.some((t) => t.startsWith(n))) return true;

  /**
   * 제목은 어절을 넘어간다 — 《왕의 남자》, 《좋은 놈, 나쁜 놈, 이상한 놈》.
   * 어절 하나만 보면 못 찾으므로, **어절 경계에서 시작해** 뒤쪽을 이어 붙여 본다.
   * 어절 중간에서 시작하는 일치는 여전히 배제된다 (그게 '서기'·'국형' 사고의 원인이었다).
   */
  for (let i = 0; i < toks.length; i++) {
    let acc = "";
    for (let j = i; j < toks.length && acc.length < n.length + 8; j++) {
      acc += toks[j];
      if (acc.startsWith(n)) return true;
    }
  }
  return false;
}

/**
 * 한 글자 제목이 **제목 표시 안에** 들어 있는가 — 《시》, 〈시〉, '시', "시".
 *
 * 실측 — "이창동 감독이 《시》로 받은 상은?" 이 《시》를 한 편도 데려오지 못했다.
 * 그래프에는 분명히 있었다 (이창동 ─DIRECTED─▶ 시). 아래 `length >= 2` 가
 * **한 글자 제목 36편**(시·콜·잠·섬·업·카…)을 후보에서 통째로 빼고 있었다.
 *
 * 그렇다고 가드를 풀 수는 없다. 평가셋 152문항에서 글자 '시' 는 **18문항**,
 * '수' 는 **19문항**에 그냥 들어 있다 — 대부분 제목이 아니라 남의 낱말 조각이다.
 *
 * 그래서 **괄호가 있을 때만** 연다. 사람이 한 글자 제목을 말할 때는 괄호를 친다.
 * 안 치면 그 글자가 제목인지 낱말인지 **사람도 구분하지 못하기 때문**이다.
 * 이 규칙으로 걸리는 문항은 152개 중 1개, 오탐은 0이다 (실측).
 */
const TITLE_MARKS = ["《》", "〈〉", "「」", "『』", "\u201c\u201d", "\u2018\u2019", "\"\"", "''"];
export function bracketedTitle(question: string, title: string): boolean {
  const t = title.trim();
  if (!t) return false;
  return TITLE_MARKS.some(([l, r]) => question.includes(`${l}${t}${r}`));
}

/**
 * 제목이 질문 안에 그대로 들어 있는가.
 * **긴 제목부터** 맞춘다 — 《범죄도시 2》를 《범죄도시》로 잘못 끊지 않도록.
 * (law-navigator 에서 '개인정보처리자'가 '개인정보'에 먹히던 것과 같은 문제)
 */
export function seedsFromTitle(question: string, g: MovieGraph): string[] {
  const q = norm(question);
  return [...g.movies.values()]
    .filter((m) => (m.title.length >= 2 && mentions(question, m.title)) || bracketedTitle(question, m.title))
    .sort((a, b) => b.title.length - a.title.length || b.popularity - a.popularity)
    .slice(0, 3)
    .map((m) => m.id);
}

/**
 * 질문에 등장하는 **모든** 인물. 긴 이름부터 맞춘다.
 * 교집합 질문("A와 B가 함께 출연한")은 두 명 이상을 봐야 한다.
 */
export function peopleIn(question: string, g: MovieGraph) {
  const q = norm(question);
  /**
   * 별칭도 본다. TMDB 는 인물을 **활동명**으로 저장한다 —
   * "아이유가 나온 영화" 가 하나도 안 잡혔던 이유다(저장된 이름은 `IU`).
   * 배역명의 로마자 문제와 달리 변환 규칙으로는 풀 수 없어서 별칭을 받아 둔다.
   */
  /**
   * 중복을 털 때 **본명이 아니라 실제로 걸린 글자**를 본다.
   *
   * 실측 — "송강호와 **이선균이** 함께 출연한 영화는?" 에 작가 '이맹유' 가 끼어들었다.
   * 별칭이 '이선' 이라 '이선균이' 의 앞부분에 걸린 것이다. 그런데 중복 판정은
   * 본명끼리 했다 — "이선균".includes("이맹유") 는 거짓이라 살아남았고,
   * 교집합이 세 사람으로 늘어 **"함께 나온 작품이 없다" 는 오답**이 나왔다.
   * 걸린 글자로 비교하면 '이선' 은 '이선균' 에 먹힌다.
   */
  const hits = [...g.people.values()]
    .map((p) => {
      /**
       * **흔한 말과 같은 이름은 쓰지 않는다.**
       * 실측 — "현빈과 손예진이 함께 **주연을** 맡은 영화는?" 에 인물 '주연' 이 끼어들어
       * 교집합이 세 사람이 됐고, 공통작이 0이 되어 《협상》이 **전제 오류**로 막혔다.
       * 말뭉치를 키우자 이런 이름이 실제로 들어왔다 — 배역명에 쓰던 목록을 여기도 쓴다.
       * 그런 이름의 배우를 못 찾게 되지만, 흔한 말로 읽히는 쪽이 압도적으로 많다.
       */
      const labels = [p.name, ...(p.aliases ?? [])]
        .filter((l) => l.length >= 2 && !NOT_A_CHARACTER.has(l) && mentionsName(question, l))
        .sort((a, b) => norm(b).length - norm(a).length);
      return labels.length ? { p, hit: norm(labels[0]) } : null;
    })
    .filter((x): x is { p: Person; hit: string } => x !== null)
    .sort((a, b) => b.hit.length - a.hit.length || b.p.popularity - a.p.popularity);

  const out: Person[] = [];
  const taken: string[] = [];
  for (const { p, hit } of hits) {
    if (taken.some((t) => t.includes(hit))) continue;   // 같은 자리를 가리키는 짧은 것
    taken.push(hit);
    out.push(p);
  }
  return out;
}

/** 질문에 등장하는 **모든** 작품 */
export function titlesIn(question: string, g: MovieGraph) {
  const q = norm(question);
  /**
   * 부제까지 그대로 말하는 사람은 없다.
   * 실측 — "지슬 어떤 영화야?" 가 말뭉치의 《지슬: 끝나지 않은 세월 2》를 못 찾아
   * **"수집 범위에서 찾지 못했습니다"** 라고 답했다. 작품은 있었는데.
   *
   * 본 제목은 짧고 흔할 수 있으므로(《아이: …》의 '아이' 가 '아이유가' 에 걸린다)
   * 시작만 보는 mentions 대신 **끝까지 보는** mentionsWhole 로 대조한다.
   */
  const hits = [...g.movies.values()]
    .map((m) => {
      if (m.title.length >= 2 && mentionsName(question, m.title)) return { m, hit: norm(m.title) };
      // 한 글자 제목은 괄호가 있을 때만 — 위 bracketedTitle 주석 참고
      if (m.title.length < 2 && bracketedTitle(question, m.title)) return { m, hit: norm(m.title) };
      const main = mainTitle(m.title);
      if (main && mentionsWhole(question, main)) return { m, hit: norm(main) };
      return null;
    })
    .filter((x): x is { m: Movie; hit: string } => x !== null)
    .sort((a, b) => b.hit.length - a.hit.length || b.m.popularity - a.m.popularity);

  const out: Movie[] = [];
  const taken: string[] = [];
  for (const { m, hit } of hits) {
    if (taken.some((t) => t.includes(hit))) continue;
    taken.push(hit);
    out.push(m);
  }
  return out;
}

/**
 * ★ 인물 교집합 — "송강호와 이선균이 함께 출연한 영화는?"
 *
 * **BM25 가 원리적으로 못 푸는 질문이다.** 《기생충》 줄거리에는 '송강호' 도
 * '이선균' 도 없다. 두 사람의 출연 목록을 각각 펼쳐 겹치는 곳을 봐야만 답이 나온다.
 * 법령판의 위임 추적과 같은 자리이고, 오히려 더 순수하다 — 교집합은 한쪽만 봐서는
 * 절대 못 구한다.
 */
export function seedsFromPeopleIntersection(question: string, g: MovieGraph, top = 5): string[] {
  const picked = peopleIn(question, g);
  if (picked.length < 2) return [];

  const sets = picked.slice(0, 3).map((p) => new Set(g.filmsOf(p.id).map((e) => e.to)));
  const common = [...sets[0]].filter((id) => sets.every((s) => s.has(id)));
  return common
    .map((id) => g.movie(id)!)
    .filter(Boolean)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, top)
    .map((m) => m.id);
}

/**
 * ★ 작품 교집합 — "‘괴물’, ‘설국열차’, ‘기생충’에 나온 배우는?"
 *
 * 답이 **사람**이므로 씨앗으로는 그 작품들을 돌려주고, 겹치는 인물은 따로 계산한다.
 */
/**
 * 제목이 같은 작품을 **묶어서** 돌려준다.
 *
 * titlesIn 은 한 제목당 한 편만 남기고 인기순으로 고른다. 그런데 말뭉치가 커지며
 * 《괴물》이 두 편이 됐고(봉준호 2006 · 고레에다 2023), 인기가 높은 2023년작이
 * 뽑혔다. 그 바람에 **"송강호가 살인의 추억·괴물·기생충에 모두 출연했다"** 가
 * 거짓으로 채점됐다 — 맞는 말인데.
 *
 * 어느 《괴물》인지는 **인기가 아니라 질문의 나머지가 정한다.** 그러니 여기서
 * 고르지 말고 다 넘긴 뒤, 공통 인물이 나오는 조합을 쓰게 한다.
 */
function titleGroupsIn(question: string, g: MovieGraph): Movie[][] {
  const groups = new Map<string, Movie[]>();
  for (const m of titlesIn(question, g)) groups.set(norm(m.title), [m]);
  for (const m of g.movies.values()) {
    const k = norm(m.title);
    const grp = groups.get(k);
    if (grp && !grp.some((x) => x.id === m.id)) grp.push(m);
  }
  return [...groups.values()];
}

export function commonPeople(question: string, g: MovieGraph, top = 5) {
  const groups = titleGroupsIn(question, g).slice(0, 4);
  if (groups.length < 2) return { movies: [] as string[], people: [] as { id: string; name: string; acted?: boolean }[] };

  // 제목 묶음마다 "그 제목의 어느 편에든 참여한 사람" 을 모은 뒤 교집합을 낸다
  const sets = groups.map((grp) => new Set(grp.flatMap((m) => g.creditsOf(m.id).map((e) => e.from))));
  const common = [...sets[0]].filter((id) => sets.every((s) => s.has(id)));

  /** 공통 인물이 실제로 참여한 편을 고른다 — 동명이작 중 어느 것인지는 이걸로 정해진다 */
  const picked = groups.map((grp) =>
    grp.find((m) => common.length && common.some((pid) => g.creditsOf(m.id).some((e) => e.from === pid))) ?? grp[0],
  );

  return {
    movies: picked.slice(0, 4).map((m) => m.id),
    // "배우는 누구인가요" 를 물었는데 감독을 먼저 내놓으면 답이 아니다.
    // 무슨 역할로 겹쳤는지를 보고 순서를 정한다.
    people: common
      .map((id) => g.person(id)!)
      .filter(Boolean)
      .map((p) => {
        const acted = picked.slice(0, 4).every((m) => g.creditsOf(m.id, "ACTED_IN").some((e) => e.from === p.id));
        return { p, acted };
      })
      .sort((a, b) => {
        if (/배우|출연|연기/.test(question) && a.acted !== b.acted) return a.acted ? -1 : 1;
        if (/감독|연출/.test(question) && a.acted !== b.acted) return a.acted ? 1 : -1;
        return b.p.popularity - a.p.popularity;
      })
      .slice(0, top)
      .map(({ p, acted }) => ({ id: p.id, name: p.name, acted })),
  };
}

/** 질문에 인물 이름이 있으면 그 사람의 대표작을 씨앗으로 준다 */
export function seedsFromPerson(question: string, g: MovieGraph, top = 4): string[] {
  // peopleIn 을 그대로 쓴다. 같은 판정을 두 곳에 두면 한쪽만 고쳐져 어긋난다 —
  // 실제로 별칭을 peopleIn 에만 넣었다가 "아이유가 나온 영화" 가 여전히 엉뚱했다.
  const hits = peopleIn(question, g);
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
/**
 * 용언 활용형에서는 배역 후보를 뽑지 않는다.
 *
 * 실측 — "호랑이가 **나오고** 포수와 대결하는 영화":
 *   나오고 → na·o·go ,  Naoko → na·o·ko
 *   배역명 표기가 표준을 안 따라서 넣은 k→g 퍼지 규칙에 걸려 같은 이름이 됐다.
 *   《바람이 분다》Naoko Satomi · 《경성학교》Naoko Oyama 가 씨앗으로 들어왔다.
 *
 * "몇 편에 걸치면 흔한 말" 규칙으로는 못 잡는다 — '나오고' 는 2편뿐이다.
 * 걸러야 할 것은 빈도가 아니라 **품사**다.
 *
 * 이름으로 끝날 수 있는 꼬리(서·지·나·은…)는 **일부러 뺐다.**
 * 넣으면 은서·민지·유나·지은이 전부 날아간다. 이름에 안 쓰이는 어미만 담는다.
 */
const VERB_TAILS = [
  "면서", "지만", "는데", "다가", "거나", "려고", "도록", "하는", "하고", "하며",
  "되는", "되고", "어서", "아서", "았다", "었다", "한다", "인가", "일까", "인지",
  "고", "며",
];
// 두 글자 이름(마고·나라…)이 꼬리와 겹쳐 날아가지 않게 세 글자부터 본다
const isConjugated = (w: string) => w.length >= 3 && VERB_TAILS.some((t) => w.endsWith(t));

/**
 * 질문이 배역을 묻고 있는가. '지역·역사·통역' 의 역은 걸리지 않게 앞 글자를 본다.
 * 평가셋 character 22문항 중 21문항이 걸린다 (나머지 하나는 제목이 지목된
 * 감독 질문이라 작품 범위로 좁히는 분기로 간다).
 */
const ASKS_CHARACTER =
  /(?<![지사구통번영])역할?(을|은|는|이|가|의|으로)?($|[\s?!.,])|연기|분한|맡은|맡았|열연|배역/;

const NOT_A_CHARACTER = new Set([
  "영화", "배우", "누구", "누구인", "누구인가", "누구인가요", "무엇", "무엇인",
  "역을", "역할", "역할을", "맡은", "맡았", "연기", "연기한", "출연", "출연한",
  "주연", "조연", "악역", "감독", "작품", "제목", "이름", "알려", "알려줘",
  "어떻게", "어떤", "무슨", "시리즈", "나오는", "나온",
  // 실측으로 잡은 것들 — 일반어가 로마자 이름으로 둔갑한다
  "이전", "이후", "이터", "그리고", "그런", "모두", "함께", "같이", "자주",
  "한국", "한국형", "좀비", "액션", "코미디", "스릴러", "드라마", "로맨스",
  "최근", "요즘", "올해", "당시", "처음", "마지막", "다른", "무엇을",
]);

export function seedsFromCharacter(question: string, g: MovieGraph, top = 3): string[] {
  // 2~4글자 한글 덩어리를 배역 후보로 본다 (조사가 붙은 형태도 앞에서 잘라 본다)
  // 어절의 **앞쪽**에서만 후보를 뽑는다. 뒤에 붙은 조사를 한 글자씩 떼어 본다.
  const cands = new Set<string>();
  for (const raw of question.split(/\s+/)) {
    const w = (raw.match(/[가-힣]{2,7}/) ?? [""])[0];
    if (isConjugated(w)) continue;   // 나오고 · 대결하는 — 사람 이름이 아니다
    for (const c of [w, w.slice(0, w.length - 1), w.slice(0, w.length - 2)]) {
      if (c.length >= 2 && !NOT_A_CHARACTER.has(c)) cands.add(c);
    }
  }
  /**
   * 질문에 작품이 지목돼 있으면 **그 작품 안에서만** 배역을 찾는다.
   *
   * 전체를 훑으면 흔한 이름이 잡음으로 걸러진다. 실측 —
   *   '기택' 6건 · '석우' 16건 · '기우' 4건 → 전부 "흔한 말" 로 제거됐다.
   * 그런데 이들은 진짜 배역명이다. **몇 편에 걸치는가로는 배역명과 일반어를
   * 가를 수 없다.** 작품이 주어졌으면 범위를 좁히는 것이 옳은 해법이다.
   */
  const scoped = titlesIn(question, g);
  if (scoped.length) {
    const hits: { id: string; len: number }[] = [];
    for (const m of scoped) {
      for (const e of g.creditsOf(m.id, "ACTED_IN")) {
        if (!e.as) continue;
        for (const c of cands) if (c.length >= 2 && nameMatches(c, e.as)) hits.push({ id: m.id, len: c.length });
      }
    }
    if (hits.length) {
      return [...new Set(hits.sort((a, b) => b.len - a.len).map((x) => x.id))].slice(0, top);
    }
  }

  /**
   * 작품이 지목되지 않았다면, **질문이 배역을 묻고 있을 때만** 전역으로 훑는다.
   *
   * 말뭉치에 배역명이 4,022개 있다. 두세 글자 한글 덩어리를 로마자로 바꿔
   * 전부와 대조하면 **우연히 겹치는 것이 거의 언제나 나온다.** 줄거리를
   * 묘사하는 질문에는 배역명이 애초에 들어 있지 않으므로, 여기서 나오는
   * 것은 전부 오인이고 진짜 씨앗(키워드)을 앞자리에서 밀어낸다.
   */
  if (!ASKS_CHARACTER.test(question)) return [];

  const scored: { id: string; len: number; pop: number; rare: number }[] = [];
  const perCand = new Map<string, number>();
  for (const m of g.movies.values()) {
    for (const e of g.creditsOf(m.id, "ACTED_IN")) {
      if (!e.as) continue;
      for (const c of cands) {
        if (c.length >= 2 && nameMatches(c, e.as)) {
          perCand.set(c, (perCand.get(c) ?? 0) + 1);
          scored.push({ id: m.id, len: c.length, pop: m.popularity, rare: 0 });
        }
      }
    }
  }
  /**
   * **여러 작품에 걸치는 후보는 배역명이 아니라 흔한 말이다.**
   * 실측: "이터널스 **이전**" 의 '이전' 이 Icheon·Lee Jun 등 5건,
   * '이터' 가 Lee Du·Lee Doo 등 9건에 걸렸다. 진짜 배역명은 한두 작품에만 나온다.
   */
  const noisy = new Set([...perCand.entries()].filter(([, n]) => n >= 4).map(([c]) => c));
  const kept = scored.filter((x) => {
    for (const [c, n] of perCand) if (noisy.has(c) && n === perCand.get(c)) { /* noop */ }
    return true;
  });
  const clean: typeof scored = [];
  for (const m of g.movies.values()) {
    for (const e of g.creditsOf(m.id, "ACTED_IN")) {
      if (!e.as) continue;
      for (const c of cands) {
        if (noisy.has(c) || c.length < 2) continue;
        if (nameMatches(c, e.as)) clean.push({ id: m.id, len: c.length, pop: m.popularity, rare: perCand.get(c) ?? 1 });
      }
    }
  }
  // 드물게 걸린 후보 → 긴 후보 → 인기순
  return [...new Set(
    clean.sort((a, b) => a.rare - b.rare || b.len - a.len || b.pop - a.pop).map((x) => x.id),
  )].slice(0, top);
}

/**
 * 수상 이름으로 작품을 찾는다.
 * "황금종려상 받은 작품" → 수상 기록에 그 상이 있는 영화들.
 */
const AWARD_NAMES = [
  "황금종려", "아카데미", "골든글로브", "여우주연", "남우주연",
  "감독상", "작품상", "각본상", "황금곰", "은곰", "칸",
];

/**
 * 인물이 받은 상 → 그 상을 받은 작품.
 *
 * "전도연이 칸 여우주연상을 받은 영화는?" 의 답은 《밀양》인데,
 * **《밀양》의 수상 기록에는 그 상이 없다.** 전도연이 받은 상이기 때문이다.
 * 위키데이터의 수상 자격(P1686)에 작품이 달려 있고 거기서 TMDB ID 를 따라가면
 * 우리 그래프와 정확히 이어진다 — 사람을 거쳐야만 닿는, 또 하나의 다리다.
 */
export function seedsFromPersonAward(question: string, g: MovieGraph, top = 4): string[] {
  const q = norm(question);
  const named = AWARD_NAMES.filter((k) => q.includes(norm(k)));
  if (!named.length) return [];

  const out: string[] = [];
  for (const p of peopleIn(question, g)) {
    for (const a of p.awards ?? []) {
      if (!named.some((k) => norm(a.award).includes(norm(k)))) continue;
      if (!a.forTmdb) continue;
      const m = [...g.movies.values()].find((x) => String(x.tmdbId) === a.forTmdb);
      if (m) out.push(m.id);
    }
  }
  return [...new Set(out)].slice(0, top);
}

export function seedsFromAward(question: string, g: MovieGraph, top = 8): string[] {
  const q = norm(question);
  const named = AWARD_NAMES.filter((k) => q.includes(norm(k)));
  // "상 받은 영화" 처럼 상 이름 없이 묻는 경우도 있다 — 그때는 수상작 전체가 후보다
  /**
   * 상 이름 없이 포괄적으로 묻는 경우.
   *
   * ⚠️ 공백을 지운 문자열에 정규식을 걸면 어절을 가로질러 걸린다. 실측 사고:
   *   "영화 제목은 무엇인가요" → 공백 제거 → "**영화제**목은…" → 영화제로 오인.
   * 그래서 이 판정만은 **원문**(공백 유지)에서 본다.
   */
  const generic = /수상|상을\s*받|상\s*받|영화제(?!목)/.test(question);
  if (!named.length && !generic) return [];

  const recent = /최근|요즘|올해|근래/.test(q);
  const hits: { id: string; pop: number; year: number }[] = [];
  for (const m of g.movies.values()) {
    const list = m.awards ?? [];
    if (!list.length) continue;
    const match = named.length
      ? list.some((a) => named.some((k) => norm(a.award).includes(norm(k))))
      : true;
    if (!match) continue;
    const latest = Math.max(0, ...list.map((a) => a.year ?? 0));
    hits.push({ id: m.id, pop: m.popularity, year: latest });
  }
  // '최근' 을 물으면 수상 연도를, 아니면 인기순을 우선한다
  hits.sort((a, b) => (recent ? b.year - a.year || b.pop - a.pop : b.pop - a.pop));
  return hits.slice(0, top).map((x) => x.id);
}

/**
 * ★ 배역 → 배우 → **그 배우의 다른 작품**.
 *
 * "《기생충》에서 기우를 연기한 배우가 출연한 좀비 영화는?" 은 **세 단계**다.
 * 가운데 배우(최우식)의 이름이 질문에 없으므로, 배역을 풀어야 비로소 사람이 나오고
 * 거기서 다시 작품으로 건너간다. 이 프로젝트에서 가장 긴 다리다.
 *
 * 탐색에 맡기면 씨앗 《기생충》에서 감독(봉준호) 쪽으로 새어 나간다 — 실측으로
 * 확인했다(괴물·살인의 추억·마더…). 그래서 배우를 특정한 뒤 **그 사람의 작품만**
 * 씨앗으로 준다.
 */
export function seedsFromCharacterActor(question: string, g: MovieGraph, top = 8): string[] {
  const onCharacterBridge = /연기한 배우가|맡은 배우가|역의 배우가|배우가 출연|배우가 주연/.test(question);
  if (!onCharacterBridge) return [];

  // 질문에 지목된 작품이 있으면 그것을 출발점으로 삼는다
  const named = titlesIn(question, g).map((m) => m.id);
  const from = named.length ? named.slice(0, 2) : seedsFromCharacter(question, g, 2);
  if (!from.length) return [];

  const cands = new Set<string>();
  for (const raw of question.split(/\s+/)) {
    const w = (raw.match(/[가-힣]{2,7}/) ?? [""])[0];
    if (isConjugated(w)) continue;
    for (const c of [w, w.slice(0, -1), w.slice(0, -2)]) {
      if (c.length >= 2 && !NOT_A_CHARACTER.has(c)) cands.add(c);
    }
  }
  const actors = new Set<string>();
  for (const mid of from) {
    for (const e of g.creditsOf(mid, "ACTED_IN")) {
      if (!e.as) continue;
      for (const c of cands) if (nameMatches(c, e.as)) actors.add(e.from);
    }
  }
  const out: string[] = [];
  for (const pid of actors) {
    for (const e of g.filmsOf(pid, "ACTED_IN")) {
      if (!from.includes(e.to) && g.movie(e.to)) out.push(e.to);
    }
  }
  let pool = [...new Set(out)];

  /**
   * 질문은 대개 **답을 좁히는 두 번째 조건**을 들고 있는데, 여기서 그걸 버렸다.
   *
   *   "《버닝》에서 종수를 연기한 배우가 **조태오로** 출연한 영화"   → 배역명
   *   "…광해군을 연기한 배우가 출연한 **김지운 감독** 영화"        → 감독
   *
   * 버리면 그 배우의 작품이 통째로 남는다. 실측 — 유아인 16편에서 《베테랑》이
   * 근거 예산(10편) 밖으로 밀렸다. 배우는 맞게 찾아 놓고 답을 잘라낸 것이다.
   * **말뭉치가 커질수록 한 사람의 작품 수가 늘어 이 손실이 커진다** —
   * 근거를 더 담는 것으로는 못 막고, 질문이 준 조건을 쓰는 것이 맞다.
   */
  const directors = peopleIn(question, g).filter((p) => g.filmsOf(p.id, "DIRECTED").length > 0);
  if (directors.length) {
    const byDir = pool.filter((id) =>
      g.creditsOf(id, "DIRECTED").some((e) => directors.some((d) => d.id === e.from)));
    if (byDir.length) pool = byDir;
  }
  // 두 번째 배역명 — cands 에는 첫 배역명도 들어 있지만, 그것은 출발 작품에만 있다
  const byChar = pool.filter((id) =>
    g.creditsOf(id, "ACTED_IN").some((e) => e.as && actors.has(e.from) &&
      [...cands].some((c) => nameMatches(c, e.as!))));
  if (byChar.length && byChar.length < pool.length) pool = byChar;

  return pool
    .map((id) => g.movie(id)!)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, top)
    .map((m) => m.id);
}

/** 장르 색인 — 법령의 '정의 용어 색인' 과 같은 자리 */
export function seedsFromGenre(question: string, g: MovieGraph, top = 3): string[] {
  const q = norm(question);
  const genre = Object.keys(g.genreIndex).find((name) => q.includes(norm(name)));
  return genre ? (g.genreIndex[genre] ?? []).slice(0, top) : [];
}

/**
 * 질문을 감싸는 상투어. BM25 에 넣기 전에 걷어낸다.
 *
 * 실측 — "세종대왕에 대한 **이야기가있는 영화 알려줘**":
 *   《천문: 하늘에 묻는다》가 6위로 밀려 씨앗(상위 3)에서 떨어졌다.
 *   '이야기' 가 《무서운 이야기 2》·《라푼젤: 끝나지 않은 이야기》를 끌어올렸기 때문이다.
 *   걷어내면 천문이 2위로 올라온다.
 *
 * IDF 가 흔한 말을 깎아 주지만, **묻는 방식에서 온 말**까지는 깎지 못한다.
 * 이것들은 문서에 있을 수도 있는 진짜 낱말이라 색인에서는 빼지 않는다 —
 * 《무서운 이야기》는 제목이다. **질문 쪽에서만** 뺀다.
 */
const QUERY_FILLER =
  /(알려줘|알려주세요|추천해줘|추천|말해줘|보여줘|찾아줘|무엇인가요|무엇인지|뭐야|뭔가요|어떤거지|어떤가요|있나요|있어|없어)|(영화|작품|이야기|내용|줄거리|관련된|관련|대한|대해|에서|나오는|나온|있는|같은)/g;

export function seedsFromKeywords(question: string, g: MovieGraph, top = 3): string[] {
  const lean = question.replace(QUERY_FILLER, " ").replace(/\s+/g, " ").trim();
  // 상투어뿐인 질문이면 원문을 쓴다 — 빈 질의로 검색하면 아무 근거나 올라온다
  const q = lean.replace(/[^가-힣0-9A-Za-z]/g, "").length >= 2 ? lean : question;
  return indexOf(g).search(q, top).map((r) => r.id);
}

/**
 * 이 질문이 영화 이야기인가.
 *
 * law-navigator 에서 "음주운전 걸렸는데" 에 개인정보 조문 10건을 내놓았던 사고를
 * 반복하지 않으려는 장치다. BM25 는 **어떤 질문에든** 상위 N 개를 돌려주므로,
 * 점수만으로는 "모르는 주제"를 걸러낼 수 없다.
 */
/** 이 영역에서만 쓰는 말 */
const DOMAIN_WORDS = ["영화", "배우", "감독", "출연", "작품", "주연", "조연", "개봉", "시리즈", "연출", "각본"];

export function domainSignal(question: string, g: MovieGraph): { ok: boolean; reason: string } {
  const q = norm(question);
  const word = DOMAIN_WORDS.find((w) => q.includes(w));

  // 강한 신호 — 이것만으로 충분하다
  if (seedsFromTitle(question, g).length) return { ok: true, reason: "작품 제목을 지목했다" };
  if (seedsFromPerson(question, g).length) return { ok: true, reason: "인물 이름이 있다" };
  if (peopleIn(question, g).length >= 2) return { ok: true, reason: "인물이 둘 이상 있다" };
  if (seedsFromPersonAward(question, g).length) return { ok: true, reason: "인물의 수상을 물었다" };
  if (seedsFromAward(question, g).length) return { ok: true, reason: "수상 이름이 있다" };
  if (word) return { ok: true, reason: `이 영역의 말: ${word}` };

  /**
   * 약한 신호 — **혼자서는 안 된다.**
   *
   * 배역명 대조는 로마자를 거치므로 본질적으로 흐릿하다. 실측으로 잡은 사고:
   *   "김치찌개 맛있게 끓이는 법" → 김치 → `gimji` → **Kim Ji-young(김지영)**
   * 김치와 김지는 로마자로 구분되지 않는다. 문자열 규칙을 더 다듬어도 못 막는다.
   *
   * 그런데 배역을 묻는 질문은 **거의 언제나 작품이나 '영화/배우' 를 함께 말한다**
   * ("영화 기생충에서 기택 역"). 그래서 배역명은 다른 신호와 함께일 때만 인정한다.
   * 장르도 마찬가지다 — '액션' 한 단어로 영화 질문이라고 볼 수는 없다.
   */
  return { ok: false, reason: "영화 이야기인지 알 수 없습니다 — 작품·인물·‘영화’ 같은 단서가 없습니다" };
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

  // 여기까지 왔다면 게이트를 통과한 것이다. 배역·장르 같은 약한 단서도 이제 쓸 수 있다.
  // 교집합은 가장 좁고 확실한 단서다 — 잡히면 그것만 쓴다
  const inter = seedsFromPeopleIntersection(question, g);
  if (inter.length) return inter;
  const common = commonPeople(question, g);
  if (common.people.length) return common.movies;

  // 배역 → 배우 → 다른 작품. 가장 좁은 단서이므로 잡히면 그것만 쓴다.
  const viaActor = seedsFromCharacterActor(question, g);
  if (viaActor.length) return viaActor;

  /**
   * 인물의 작품을 묻는데 그 사람이 특정됐으면 **그 사람의 작품만** 쓴다.
   * BM25 를 함께 부르면 글자만 겹치는 잡음이 씨앗에 섞인다 — 실측에서
   * "아이유가 나온 영화" 에 《나쁜 영화》·《아이 캔 스피크》·《헨젤과 그레텔》이
   * 들어왔다. 물은 사람은 하나인데 답이 여섯 곳에서 나오면 답이 아니다.
   */
  const r = route(question);
  if (r.route === "filmography" || r.route === "cast") {
    const only = seedsFromPerson(question, g, 12);
    if (only.length) return only;
  }

  const titles = seedsFromTitle(question, g);
  const people = seedsFromPerson(question, g);
  const chars = seedsFromCharacter(question, g);
  const awards = seedsFromAward(question, g);
  const pAwards = seedsFromPersonAward(question, g);

  /**
   * **제목·인물·수상은 확실한 단서**다. 잡히면 거기서 출발하고 BM25 는 부르지 않는다.
   * (인물 수상이 가장 좁으므로 맨 앞에 둔다)
   *
   * 배역은 다르다. 로마자를 거쳐 대조하므로 본질적으로 흐릿하다. 홀드아웃에서
   * 이것 때문에 줄거리 질문이 무너졌다 —
   *   "딸을 데리고 부산으로 향하던 KTX 안에서 좀비…"
   *   배역 씨앗 《두더지》·《몬스터 대학교》가 잡히자 BM25 를 아예 부르지 않았고,
   *   정작 BM25 2위가 《부산행》이었다.
   * 그래서 배역 씨앗은 **BM25 를 막지 않는다.** 앞에 두되 뒤를 함께 담는다.
   */
  /**
   * **확실한 단서가 있어도 BM25 를 막지 않는다.**
   *
   * 실측 — "독일 기자를 태운 택시기사가 **1980년** 광주로 향하는 영화는?":
   *   '1980년' 이 《1980》(2024)이라는 **제목**에 걸려 이 분기로 들어왔고,
   *   BM25 가 이미 1위로 뽑아 둔 《택시운전사》(42.79점)는 **호출조차 되지 않았다.**
   *
   * 바로 아래 배역 씨앗에서 똑같은 일을 겪고 고쳤는데(《부산행》 사고),
   * 제목에는 안 고쳤었다. **같은 함정의 다른 입구다.**
   * 확실한 단서를 앞에 두는 것은 맞지만, 뒤를 닫을 이유는 없다 —
   * 순서가 이미 우선순위를 표현하고, 넘치는 것은 근거 예산이 자른다.
   */
  if (titles.length || awards.length || pAwards.length) {
    return [...new Set([
      ...pAwards, ...titles, ...chars, ...awards, ...people,
      ...seedsFromKeywords(question, g, top),
    ])];
  }
  return [
    ...new Set([
      ...chars,
      ...people,
      ...seedsFromGenre(question, g),
      /**
       * 키워드 씨앗만 **두 배로** 가져온다.
       *
       * 여기까지 왔다는 것은 제목·인물·수상 같은 확실한 단서가 하나도 없다는 뜻이다.
       * 그런 질문일수록 BM25 순위가 흔들린다 — 실측에서 《천문》이 2위였다가
       * 상투어 하나에 6위로 밀렸다. 확실한 단서가 없을 때 상위 3개만 보는 것은
       * **순위를 너무 믿는 것**이다. 근거 예산이 10편이므로 6개는 감당한다.
       */
      ...seedsFromKeywords(question, g, top * 2),
    ]),
  ];
}

/**
 * 질문의 **전제**가 사실인가.
 *
 * "추격자·황해·곡성에 모두 출연한 배우는?" — 실제로는 **그런 배우가 없다.**
 * 겹치는 사람은 감독 나홍진뿐이다. 이때 근거 10편을 늘어놓으면
 * 답하지 않으면서 답하는 척하는 것이 된다.
 *
 * 거절(out_of_scope)과는 다르다. 거절은 "이 도구가 다룰 범위가 아니다" 이고,
 * 이쪽은 **"찾아봤는데 전제가 사실이 아니다"** 다. 찾아본 결과를 근거로 말해야 하므로
 * 오히려 더 강한 주장이다. 공통점은 하나 — **답을 지어내지 않는다.**
 */
export interface PremiseCheck {
  /** 전제가 무너졌는가 */
  broken: boolean;
  reason: string;
  /** 대신 말해 줄 수 있는 것 (감독만 겹친다든지) */
  instead?: string;
}

export function checkPremise(question: string, g: MovieGraph): PremiseCheck {
  const asksActor = /배우|출연|연기/.test(question);

  /**
   * ③ 인물·작품을 지목했는데 **그 대상이 말뭉치에 없다.**
   *
   * "아이유가 나온 영화 알려줘" — 아이유는 수집 범위 밖이다.
   * 그런데 BM25 가 글자만 겹치는 《아이 캔 스피크》·《나쁜 영화》를 끌어왔고,
   * 화면에는 아이유와 무관한 10편이 근거로 떴다. LLM 은 "확인되지 않습니다" 라고
   * 바르게 답했지만, **그 전에 막았어야 한다** — 무관한 근거를 보여 주는 것 자체가
   * 사용자를 속인다.
   *
   * 인물의 작품을 묻는 질문에서 **기준점이 하나도 없으면** 답할 수 없다.
   *
   * 다만 **"지목했는데 없다" 와 "애초에 아무도 지목하지 않았다" 는 다르다.**
   * 실측 — "제주도를 **배경으로 만든 영화** 알려줘" 가 '만든 영화' 때문에
   * 인물의 작품 질문으로 분류됐고, 인물이 없으니 **"전제가 사실과 다릅니다"** 라고
   * 답했다. 전제가 틀린 게 아니라 **질문을 잘못 읽은 것**이다 —
   * 《계춘할망》·《지슬》·《올레》가 다 말뭉치에 있다.
   *
   * 누군가를 지목한 질문은 그 주체가 **주격·소유격 조사**를 달고 나온다
   * ("브래드 피트**가** 나온", "봉준호**의** 영화"). 그게 없으면 지목이 아니다.
   */
  const namesSubject = /[가-힣]{2,5}(가|이|의)\s/.test(question) || /감독|배우/.test(question);
  const r = route(question);
  if (namesSubject && (r.route === "filmography" || r.route === "cast") &&
      !peopleIn(question, g).length && !titlesIn(question, g).length) {
    return {
      broken: true,
      reason: "질문에 나온 **인물이나 작품을 수집 범위에서 찾지 못했습니다**",
      instead: `이 도구는 한국 영화 ${STATS.korean.toLocaleString()}편과 그 인물이 참여한 외국 영화 ${STATS.foreign.toLocaleString()}편만 다룹니다`,
    };
  }

  // ① 작품 교집합 — "A·B·C에 모두 출연한 배우"
  const titles = titlesIn(question, g);
  if (asksActor && titles.length >= 2) {
    const cp = commonPeople(question, g);
    const actors = cp.people.filter((p) => p.acted !== false);
    if (!actors.length) {
      const crew = cp.people.filter((p) => p.acted === false).map((p) => p.name);
      return {
        broken: true,
        reason: `${titles.slice(0, 4).map((m) => `《${m.title}》`).join(" ")} 에 **모두 출연한 배우는 없습니다**`,
        instead: crew.length ? `모두 참여한 사람은 ${crew.slice(0, 3).join(", ")} (제작진)` : undefined,
      };
    }
  }

  // ② 인물 교집합 — "A와 B가 함께 나온 영화"
  const ps = peopleIn(question, g);
  if (ps.length >= 2 && /함께|같이|모두/.test(question)) {
    if (!seedsFromPeopleIntersection(question, g, 1).length) {
      return {
        broken: true,
        reason: `${ps.slice(0, 2).map((p) => p.name).join(" 와 ")} 가 **함께 나온 작품이 없습니다**`,
      };
    }
  }

  return { broken: false, reason: "" };
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
