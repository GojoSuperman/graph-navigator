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
  "와 함께", "과 함께", "함께 출연", "함께 주연", "같이 출연", "모두 출연", "자주 출연",
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
 * 제목이 질문 안에 그대로 들어 있는가.
 * **긴 제목부터** 맞춘다 — 《범죄도시 2》를 《범죄도시》로 잘못 끊지 않도록.
 * (law-navigator 에서 '개인정보처리자'가 '개인정보'에 먹히던 것과 같은 문제)
 */
export function seedsFromTitle(question: string, g: MovieGraph): string[] {
  const q = norm(question);
  return [...g.movies.values()]
    .filter((m) => m.title.length >= 2 && mentions(question, m.title))
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
  const hits = [...g.people.values()]
    .filter((p) => p.name.length >= 2 && mentions(question, p.name))
    .sort((a, b) => b.name.length - a.name.length || b.popularity - a.popularity);
  // '송강호' 가 잡혔으면 '송강' 은 같은 자리를 가리키는 잡음이다. 긴 쪽이 이긴다.
  const out: typeof hits = [];
  for (const p of hits) {
    if (out.some((x) => norm(x.name).includes(norm(p.name)))) continue;
    out.push(p);
  }
  return out;
}

/** 질문에 등장하는 **모든** 작품 */
export function titlesIn(question: string, g: MovieGraph) {
  const q = norm(question);
  const hits = [...g.movies.values()]
    .filter((m) => m.title.length >= 2 && mentions(question, m.title))
    .sort((a, b) => b.title.length - a.title.length || b.popularity - a.popularity);
  const out: typeof hits = [];
  for (const m of hits) {
    if (out.some((x) => norm(x.title).includes(norm(m.title)))) continue;
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
export function commonPeople(question: string, g: MovieGraph, top = 5) {
  const picked = titlesIn(question, g);
  if (picked.length < 2) return { movies: [] as string[], people: [] as { id: string; name: string; acted?: boolean }[] };

  const sets = picked.slice(0, 4).map((m) => new Set(g.creditsOf(m.id).map((e) => e.from)));
  const common = [...sets[0]].filter((id) => sets.every((s) => s.has(id)));
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
  const q = norm(question);
  const hits = [...g.people.values()]
    .filter((p) => p.name.length >= 2 && mentions(question, p.name))
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
    for (const c of [w, w.slice(0, w.length - 1), w.slice(0, w.length - 2)]) {
      if (c.length >= 2 && !NOT_A_CHARACTER.has(c)) cands.add(c);
    }
  }
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
  for (const p of g.people.values()) {
    if (p.name.length < 2 || !mentions(question, p.name)) continue;
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

  const titles = seedsFromTitle(question, g);
  const people = seedsFromPerson(question, g);
  const chars = seedsFromCharacter(question, g);
  const awards = seedsFromAward(question, g);
  const pAwards = seedsFromPersonAward(question, g);

  // 제목·배역·수상은 확실한 단서다. 하나라도 잡히면 거기서 출발하고 BM25 는 부르지 않는다.
  // 인물 수상은 가장 좁은 단서다 — 맨 앞에 둔다
  if (titles.length || chars.length || awards.length || pAwards.length) {
    return [...new Set([...pAwards, ...titles, ...chars, ...awards, ...people])];
  }

  return [...new Set([...people, ...seedsFromGenre(question, g), ...seedsFromKeywords(question, g, top)])];
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
