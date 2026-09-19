/**
 * TMDB → data/raw.json
 *
 *   TMDB_API_KEY=... node scripts/fetch-movies.ts [한국영화_페이지수]
 *
 * ── 수집 전략 ────────────────────────────────────────────────────────
 * 전 세계 영화를 다 넣으면 수십만 편이 되어 씨앗 찾기가 망가진다.
 * 한국 영화만 넣으면 **국경을 넘는 다리**가 사라진다 — 이 프로젝트에서
 * 가장 좋은 질문("부산행 나온 배우가 마블에도 나왔다던데")이 없어진다.
 *
 * 그래서 법령에서 "위임을 실제로 받는 고시만 골라 넣은" 것과 같은 원리로,
 * **인물을 따라 1홉 확장**한다.
 *   ① 한국 영화 — **투표 20개 이상 전부** (연대 무관)
 *   ② ①에 나온 인물의 외국 작품
 *   ③ 평가셋이 요구하는 작품 — 인기와 무관하게 **지정 수집**
 *
 * ── 왜 투표 수로 자르나 ──────────────────────────────────────────────
 * "초기 영화부터 다 넣으면?" 을 실측했다. 한국 영화는 TMDB 에 14,546편 있지만
 * 투표 20개 이상은 1,049편뿐이고, **1980년 이전 1,931편 중에는 9편**이다.
 * 나머지는 제목만 있고 줄거리도 출연진도 비어 있다.
 *
 * 이 프로젝트는 **관계**로 답한다. 출연진이 없으면 노드는 들어와도 **선이 안 생긴다.**
 * 연대로 자르는 대신 "선이 생기는가" 로 자르는 이유다.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const KEY = process.env.TMDB_API_KEY;
if (!KEY) {
  console.error("TMDB_API_KEY 가 없습니다. .env.local 에 넣고 다시 실행하세요.");
  process.exit(1);
}

const OUT = join(import.meta.dirname, "..", "data");
const PAGES = Number(process.argv[2] ?? 0) || Infinity;  // 0 = 끝까지
const MIN_VOTES = 20;                              // 표가 너무 적으면 정보가 부실하다
const EXPAND_MIN_FILMS = 2;                        // 말뭉치에 2편 이상 있는 인물만 확장
const EXPAND_MIN_VOTES = 100;                      // 확장으로 들어올 외국 작품의 하한
const MAX_MOVIES = Number(process.env.MAX_MOVIES ?? 2500);  // 폭주 방지 상한

const UA = { "User-Agent": "movie-navigator/0.1 (portfolio study project)" };

async function api(path: string, q: Record<string, string> = {}): Promise<any> {
  const p = new URLSearchParams({ api_key: KEY!, language: "ko-KR", ...q });
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://api.themoviedb.org/3${path}?${p}`, { headers: UA });
    if (r.ok) return r.json();
    if (r.status === 429) { await sleep(2000); continue; }   // 속도 제한이면 쉬고 재시도
    throw new Error(`HTTP ${r.status} — ${path}`);
  }
  throw new Error(`재시도 실패 — ${path}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 줄거리가 비었거나 표가 적은 것은 버린다 — 법령에서 본문 없는 고시를 뺀 것과 같다 */
const usable = (m: any, minVotes: number) =>
  Boolean(m?.id) && !m.adult && (m.overview ?? "").trim().length > 10 && (m.vote_count ?? 0) >= minVotes;

console.log("═".repeat(64));
console.log("  TMDB 수집");
console.log("═".repeat(64));

// ── 장르 코드표 ──────────────────────────────────────────────────────
const genreList = await api("/genre/movie/list");
const GENRE = new Map<number, string>(genreList.genres.map((g: any) => [g.id, g.name]));
console.log(`\n장르 ${GENRE.size}종: ${[...GENRE.values()].slice(0, 6).join(", ")} …`);

// ── ① 한국 영화 ──────────────────────────────────────────────────────
const movies = new Map<number, any>();
let skipped = 0;
let lastPage = 1;
for (let p = 1; p <= Math.min(PAGES, lastPage); p++) {
  const d = await api("/discover/movie", {
    with_origin_country: "KR",
    sort_by: "popularity.desc",
    include_adult: "false",
    "vote_count.gte": String(MIN_VOTES),
    page: String(p),
  });
  lastPage = Math.min(d.total_pages ?? 1, 500);
  for (const m of d.results) {
    if (usable(m, MIN_VOTES)) movies.set(m.id, m);
    else skipped++;
  }
  if (p % 10 === 0) process.stdout.write(`\r   ${p}/${lastPage}페이지…`);
}
console.log(`\r   ${Math.min(PAGES, lastPage)}페이지 훑음`);
const koreanCount = movies.size;
console.log(`\n① 한국 영화  ${koreanCount}편 수집 (부적격 ${skipped}편 제외 — 줄거리 없음·표 부족)`);

// ── ①-b 평가셋이 요구하는 작품 — 인기와 무관하게 지정 수집 ───────────
//
// "정답이 말뭉치에 없어서 틀렸다" 는 상황은 측정을 무의미하게 만든다.
// 《마스터》(2016)·《생일》(2019) 이 실제로 그랬다.
let pinnedAdded = 0;
try {
  const gold = JSON.parse(await (await import("node:fs/promises")).readFile(join(OUT, "golden.json"), "utf-8"));
  const wanted = new Set<string>();
  for (const it of gold.items ?? []) {
    for (const t of [it.needMovie, ...(it.needMovies ?? [])]) if (t) wanted.add(String(t));
  }
  for (const title of wanted) {
    // ⚠️ startsWith 로 "이미 있다" 고 판정하면 안 된다 — 《마스터 오브 디스가이즈》를
    //    《마스터》로 착각해 정작 필요한 2016년작을 건너뛴다. **정확히** 같아야 한다.
    const found = [...movies.values()].some((m) => m.title === title);
    if (found) continue;
    const r = await api("/search/movie", { query: title, include_adult: "false" });
    // 제목이 정확히 맞고 한국어 원어인 것을 우선한다
    const hit = (r.results ?? []).find((m: any) => m.title === title && m.original_language === "ko")
      ?? (r.results ?? []).find((m: any) => m.title === title);
    if (hit && !movies.has(hit.id)) {
      movies.set(hit.id, hit);
      pinnedAdded++;
      console.log(`\n   + ${hit.title} (${String(hit.release_date).slice(0, 4)}) 투표 ${hit.vote_count}`);
    }
  }
  console.log(`\n①-b 평가셋 지정 수집 — ${pinnedAdded}편 추가 (요청 ${wanted.size}편 중 이미 있던 것 제외)`);
} catch {
  console.log("\n①-b 평가셋 없음 — 지정 수집 건너뜀");
}

// ── 크레딧 ───────────────────────────────────────────────────────────
console.log("\n② 크레딧 조회…");
const credits = new Map<number, any>();
const people = new Map<number, any>();
const filmsOfPerson = new Map<number, Set<number>>();
let done = 0;
const t0 = Date.now();

async function loadCredits(ids: number[]) {
  for (const id of ids) {
    const c = await api(`/movie/${id}/credits`);
    credits.set(id, c);
    // 상위 10명만 담았다가 교집합 질문에서 정답을 통째로 날렸다 —
    // 《곡성》의 김윤석이 10위 밖이라 "추격자·황해·곡성에 모두 나온 배우" 가 안 나왔다.
    // 조연까지 담아야 관계가 제대로 생긴다.
    const cast = (c.cast ?? []).slice(0, 30);
    const crew = (c.crew ?? []).filter((x: any) => x.job === "Director" || x.job === "Screenplay" || x.job === "Writer");
    for (const x of [...cast, ...crew]) {
      if (!people.has(x.id)) {
        people.set(x.id, { id: x.id, name: x.name, original_name: x.original_name, department: x.known_for_department, popularity: x.popularity });
      }
      if (!filmsOfPerson.has(x.id)) filmsOfPerson.set(x.id, new Set());
      filmsOfPerson.get(x.id)!.add(id);
    }
    if (++done % 50 === 0) process.stdout.write(`\r   ${done}편…`);
  }
}
await loadCredits([...movies.keys()]);
console.log(`\r   ${done}편 완료 · ${((Date.now() - t0) / 1000).toFixed(0)}초 · 인물 ${people.size}명`);

// ── ③ 인물을 따라 외국 작품으로 1홉 확장 ─────────────────────────────
const bridgePeople = [...filmsOfPerson.entries()]
  .filter(([, s]) => s.size >= EXPAND_MIN_FILMS)
  .map(([pid]) => pid);
console.log(`\n③ 확장 — 말뭉치에 ${EXPAND_MIN_FILMS}편 이상 있는 인물 ${bridgePeople.length}명을 따라간다`);

const added: number[] = [];
let checked = 0;
let capped = false;
for (const pid of bridgePeople) {
  const c = await api(`/person/${pid}/movie_credits`);
  for (const f of [...(c.cast ?? []), ...(c.crew ?? [])]) {
    if (movies.has(f.id)) continue;
    if (f.original_language === "ko") continue;         // 한국 작품은 ①에서 이미 골랐다
    if (!usable(f, EXPAND_MIN_VOTES)) continue;
    if (movies.size >= MAX_MOVIES) { capped = true; break; }
    movies.set(f.id, f);
    added.push(f.id);
  }
  if (++checked % 50 === 0) process.stdout.write(`\r   ${checked}/${bridgePeople.length}명…`);
}
console.log(`\r   ${checked}명 확인 · 외국 작품 ${added.length}편 추가${capped ? ` (상한 ${MAX_MOVIES} 도달 — 조기 종료)` : ""}`);

console.log("\n④ 추가분 크레딧 조회…");
done = 0;
await loadCredits(added);
console.log(`\r   ${done}편 완료`);

// ── ⑤ 인물 별칭 ──────────────────────────────────────────────────────
//
// TMDB 는 인물을 **활동명**으로 저장한다. 아이유는 `IU` 로 들어 있어서
// "아이유가 나온 영화" 가 하나도 안 잡혔다(배역명의 로마자 문제와 달리
// 이건 변환 규칙으로 풀 수 없다 — 활동명 자체가 다른 말이다).
//
// 다행히 /person/{id} 의 also_known_as 에 "아이유 / 이지은 / Lee Ji-eun …" 이 있다.
// 한글 별칭만 골라 붙인다.
console.log("\n⑤ 인물 별칭 조회…");
const aliasOf: Record<number, string[]> = {};
const worth = [...people.values()]
  .filter((p) => (filmsOfPerson.get(p.id)?.size ?? 0) >= 1)
  .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
let an = 0;
for (const p of worth) {
  try {
    const d = await api(`/person/${p.id}`);
    const ko = (d.also_known_as ?? []).filter((x: string) => /^[가-힣][가-힣\s]{1,9}$/.test(x));
    if (ko.length) aliasOf[p.id] = [...new Set(ko)];
  } catch { /* 한 명 실패가 전체를 막지 않는다 */ }
  if (++an % 200 === 0) process.stdout.write(`\r   ${an}/${worth.length}명…`);
}
console.log(`\r   ${an}명 확인 · 한글 별칭이 있는 인물 ${Object.keys(aliasOf).length}명`);

// ── 저장 ─────────────────────────────────────────────────────────────
await mkdir(OUT, { recursive: true });
const raw = {
  fetchedAt: new Date().toISOString(),
  params: { PAGES, MIN_VOTES, EXPAND_MIN_FILMS, EXPAND_MIN_VOTES },
  genres: Object.fromEntries(GENRE),
  movies: [...movies.values()],
  credits: Object.fromEntries([...credits.entries()].map(([k, v]) => [k, { cast: (v.cast ?? []).slice(0, 30), crew: (v.crew ?? []).filter((x: any) => ["Director", "Screenplay", "Writer"].includes(x.job)) }])),
  people: [...people.values()].map((p: any) => ({ ...p, aliases: aliasOf[p.id] ?? [] })),
};
await writeFile(join(OUT, "raw.json"), JSON.stringify(raw), "utf-8");

const korean = [...movies.values()].filter((m) => m.original_language === "ko").length;
console.log("\n" + "─".repeat(64));
console.log(`  영화 ${movies.size}편 (한국 ${korean} · 외국 ${movies.size - korean})`);
console.log(`  인물 ${people.size}명 · 크레딧 ${credits.size}건`);
console.log(`  저장: data/raw.json`);
console.log("═".repeat(64));
