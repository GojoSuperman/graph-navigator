/**
 * data/raw.json → data/graph.json + 품질 보고서
 *
 *   node scripts/build-graph.ts
 *
 * **LLM 을 호출하지 않는다.** 관계는 TMDB 크레딧에 이미 명시돼 있으므로
 * 지어낼 여지가 없다. 법령에서 참조·위임을 정규식으로 뽑은 것과 같은 자리다.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  movieId, personId, collectionId,
  type Collection, type Edge, type GraphData, type Movie, type Person,
} from "../lib/types.ts";

const DATA = join(import.meta.dirname, "..", "data");
const raw = JSON.parse(await readFile(join(DATA, "raw.json"), "utf-8"));

// 수상 정보는 별도 출처(위키데이터)다. 없으면 없는 대로 진행한다 —
// 한 출처가 빠졌다고 그래프 전체를 못 만들 이유가 없다.
let awardsOf: Record<string, { award: string; year: number | null }[]> = {};
let personAwardsOf: Record<string, any[]> = {};
try {
  const a = JSON.parse(await readFile(join(DATA, "awards.json"), "utf-8"));
  awardsOf = a.awards ?? {};
  personAwardsOf = a.personAwards ?? {};
} catch {
  console.log("  (수상 데이터 없음 — scripts/fetch-awards.ts 를 먼저 돌리면 붙는다)");
}
const GENRE = new Map<number, string>(Object.entries(raw.genres).map(([k, v]) => [Number(k), v as string]));

const L = (s = "") => console.log(s);
L("═".repeat(64));
L("  그래프 구축");
L("═".repeat(64));

// ── 노드 ─────────────────────────────────────────────────────────────
const movies: Movie[] = raw.movies.map((m: any) => ({
  id: movieId(m.id),
  tmdbId: m.id,
  title: m.title ?? m.original_title ?? "",
  originalTitle: m.original_title ?? "",
  year: m.release_date ? Number(String(m.release_date).slice(0, 4)) : null,
  overview: m.overview ?? "",
  genres: (m.genre_ids ?? []).map((g: number) => GENRE.get(g)).filter(Boolean) as string[],
  countries: m.origin_country ?? [],
  originalLanguage: m.original_language ?? "",
  popularity: m.popularity ?? 0,
  voteAverage: m.vote_average ?? 0,
  voteCount: m.vote_count ?? 0,
  posterPath: m.poster_path ?? null,
  collection: null,
  awards: awardsOf[String(m.id)] ?? undefined,
}));

const people: Person[] = raw.people.map((p: any) => ({
  id: personId(p.id),
  tmdbId: p.id,
  name: p.name ?? "",
  originalName: p.original_name ?? "",
  department: p.department ?? "",
  popularity: p.popularity ?? 0,
  awards: personAwardsOf[p.name ?? ""] ?? undefined,
  aliases: p.aliases?.length ? p.aliases : undefined,
}));

const collections: Collection[] = [];

// ── 엣지 ─────────────────────────────────────────────────────────────
const movieIds = new Set(movies.map((m) => m.id));
const personIds = new Set(people.map((p) => p.id));
const edges: Edge[] = [];
const seen = new Set<string>();

function push(from: string, to: string, kind: Edge["kind"], extra: Partial<Edge> = {}) {
  // 말뭉치 밖 노드로는 엣지를 만들지 않는다 (법령의 '수집 범위 밖' 규칙과 같다)
  if (!personIds.has(from) && !movieIds.has(from)) return;
  if (!movieIds.has(to) && !personIds.has(to)) return;
  const k = `${from}>${to}>${kind}`;
  if (seen.has(k)) return;
  seen.add(k);
  edges.push({ from, to, kind, origin: "api", ...extra });
}

const JOB_KIND: Record<string, Edge["kind"]> = {
  Director: "DIRECTED",
  Screenplay: "WROTE",
  Writer: "WROTE",
};

for (const [mid, c] of Object.entries<any>(raw.credits)) {
  const to = movieId(Number(mid));
  if (!movieIds.has(to)) continue;
  for (const a of c.cast ?? []) {
    push(personId(a.id), to, "ACTED_IN", { as: a.character || undefined, order: a.order });
  }
  for (const w of c.crew ?? []) {
    const kind = JOB_KIND[w.job];
    if (kind) push(personId(w.id), to, kind);
  }
}

// ── 장르 색인 ────────────────────────────────────────────────────────
// 법령의 '정의 용어 색인' 과 같은 자리 — 씨앗 찾기에만 쓰고 탐색에는 쓰지 않는다.
// 장르를 노드로 만들면 '액션' 하나에 수백 편이 매달려 탐색이 그리로 새어 나간다.
const genreIndex: Record<string, string[]> = {};
for (const m of movies) {
  for (const g of m.genres) {
    (genreIndex[g] ??= []).push(m.id);
  }
}
for (const g of Object.keys(genreIndex)) {
  genreIndex[g] = genreIndex[g]
    .map((id) => movies.find((m) => m.id === id)!)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 30)
    .map((m) => m.id);
}

const graph: GraphData = { movies, people, collections, edges, genreIndex };
await writeFile(join(DATA, "graph.json"), JSON.stringify(graph), "utf-8");

/**
 * 화면 첫 줄에 쓸 편수. 손으로 적어 두었더니 **수집을 넓힌 뒤에도 옛 숫자가
 * 그대로 떠 있었다** (1,018편이라고 적힌 채 2,212편을 쓰고 있었다).
 * 숫자를 말하는 곳은 숫자를 만드는 곳과 같아야 한다.
 */
const koCount = movies.filter((m) => m.originalLanguage === "ko").length;
await writeFile(
  join(DATA, "stats.json"),
  JSON.stringify({ movies: movies.length, korean: koCount, foreign: movies.length - koCount, people: people.length, edges: edges.length }, null, 2),
  "utf-8",
);

// ── 품질 보고서 ──────────────────────────────────────────────────────
const deg = new Map<string, number>();
for (const e of edges) {
  deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
  deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
}
const byKind = edges.reduce<Record<string, number>>((a, e) => ((a[e.kind] = (a[e.kind] ?? 0) + 1), a), {});
const korean = movies.filter((m) => m.originalLanguage === "ko").length;
const isolatedMovies = movies.filter((m) => !deg.get(m.id)).length;
const isolatedPeople = people.filter((p) => !deg.get(p.id)).length;

// 국경을 넘는 다리 — 한국 작품과 외국 작품 양쪽에 걸친 인물
const filmsOf = new Map<string, Movie[]>();
const movieById = new Map(movies.map((m) => [m.id, m]));
for (const e of edges) {
  if (!personIds.has(e.from)) continue;
  (filmsOf.get(e.from) ?? filmsOf.set(e.from, []).get(e.from)!).push(movieById.get(e.to)!);
}
const bridges = [...filmsOf.entries()].filter(([, fs]) => {
  const ko = fs.some((f) => f?.originalLanguage === "ko");
  const fo = fs.some((f) => f && f.originalLanguage !== "ko");
  return ko && fo;
});

L(`\n[ 노드 ]`);
L(`  영화 ${movies.length}편 (한국 ${korean} · 외국 ${movies.length - korean})`);
L(`  인물 ${people.length}명`);
L(`\n[ 엣지 ] 총 ${edges.length}개`);
for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) L(`  ${k.padEnd(10)} ${v}`);
L(`  평균 연결 ${(([...deg.values()].reduce((a, b) => a + b, 0)) / deg.size).toFixed(2)}`);

L(`\n[ 국경을 넘는 다리 ] — 한국 작품과 외국 작품에 모두 참여한 인물`);
L(`  ${bridges.length}명`);
for (const [pid, fs] of bridges.sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
  const p = people.find((x) => x.id === pid)!;
  // 감독 겸 각본이면 같은 영화로 엣지가 둘이라 중복이 생긴다
  const uniq = (xs: string[]) => [...new Set(xs)];
  const ko = uniq(fs.filter((f) => f?.originalLanguage === "ko").map((f) => f.title));
  const fo = uniq(fs.filter((f) => f && f.originalLanguage !== "ko").map((f) => f.title));
  L(`   ${p.name} — 한국 ${ko.slice(0, 2).join(", ")} / 외국 ${fo.slice(0, 2).join(", ")}`);
}

const awardedPeople = people.filter((p) => p.awards?.length);
const awarded = movies.filter((m) => m.awards?.length);
L(`\n[ 수상 ] 수상작 ${awarded.length}편 · 기록 ${awarded.reduce((a, m) => a + m.awards!.length, 0)}건`);
for (const m of awarded.sort((a, b) => b.awards!.length - a.awards!.length).slice(0, 5)) {
  L(`   ${m.title} (${m.awards!.length}) — ${m.awards!.slice(0, 3).map((a) => a.award).join(", ")}`);
}

L(`  인물 수상 — 수상자 ${awardedPeople.length}명 · 기록 ${awardedPeople.reduce((a, p) => a + p.awards!.length, 0)}건`);
for (const p of awardedPeople.sort((a, b) => b.popularity - a.popularity).slice(0, 4)) {
  const withWork = p.awards!.filter((a: any) => a.forTitle);
  L(`   ${p.name} (${p.awards!.length}) — ${withWork.slice(0, 2).map((a: any) => `${a.award}〈${a.forTitle}〉`).join(", ") || p.awards!.slice(0, 2).map((a: any) => a.award).join(", ")}`);
}

L(`\n[ 품질 점검 ]`);
L(`  연결이 하나도 없는 영화 ${isolatedMovies}편 · 인물 ${isolatedPeople}명`);
L(`  장르 색인 ${Object.keys(genreIndex).length}종`);
L(`\n저장: data/graph.json`);
L("═".repeat(64));
