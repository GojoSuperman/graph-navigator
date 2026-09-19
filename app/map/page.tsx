/**
 * 지도 — 말뭉치가 어떻게 생겼는지 한눈에.
 *
 * 법령판의 '법 지도' 와 같은 자리다. 숫자는 전부 **LLM 없이** 그래프에서 직접 센 것이다.
 * 특히 '국경을 넘는 인물' 은 이 프로젝트의 수집 전략(인물을 따라 1홉 확장)이
 * 실제로 다리를 만들어 냈는지를 보여 준다.
 */
import Link from "next/link";
import { loadGraph } from "@/lib/data.ts";

export const runtime = "nodejs";
export const metadata = { title: "지도 — 영화 네비게이터" };

export default async function MapPage() {
  const g = await loadGraph();
  const movies = [...g.movies.values()];
  const korean = movies.filter((m) => m.originalLanguage === "ko");

  const byDecade = new Map<string, number>();
  for (const m of korean) {
    if (!m.year) continue;
    const d = `${Math.floor(m.year / 10) * 10}년대`;
    byDecade.set(d, (byDecade.get(d) ?? 0) + 1);
  }
  const decades = [...byDecade.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const maxDec = Math.max(...decades.map(([, n]) => n));

  const byGenre = new Map<string, number>();
  for (const m of movies) for (const gg of m.genres) byGenre.set(gg, (byGenre.get(gg) ?? 0) + 1);
  const genres = [...byGenre.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxGen = genres[0]?.[1] ?? 1;

  // 국경을 넘는 인물 — 한국 작품과 외국 작품 양쪽에 참여
  const bridges: { id: string; name: string; ko: string[]; fo: string[] }[] = [];
  for (const p of g.people.values()) {
    const fs = [...new Set(g.filmsOf(p.id).map((e) => e.to))].map((x) => g.movie(x)).filter(Boolean);
    const ko = [...new Set(fs.filter((f) => f!.originalLanguage === "ko").map((f) => f!.title))];
    const fo = [...new Set(fs.filter((f) => f!.originalLanguage !== "ko").map((f) => f!.title))];
    if (ko.length && fo.length) bridges.push({ id: p.id, name: p.name, ko, fo });
  }
  bridges.sort((a, b) => b.ko.length + b.fo.length - (a.ko.length + a.fo.length));

  const hubs = [...g.movies.keys()]
    .map((id) => ({ id, deg: g.degree(id) }))
    .sort((a, b) => b.deg - a.deg).slice(0, 12)
    .map(({ id, deg }) => ({ m: g.movie(id)!, deg }));

  const awarded = movies.filter((m) => m.awards?.length);

  return (
    <main className="wrap">
      <header className="hd">
        <h1>지도</h1>
        <p>
          영화 {movies.length.toLocaleString()}편 · 인물 {g.people.size.toLocaleString()}명.
          이 숫자는 전부 <b>LLM 없이</b> 그래프에서 직접 센 것입니다.
        </p>
      </header>

      <section className="card">
        <h2>수집 범위</h2>
        <p className="hint">
          연대가 아니라 <b>선이 생기는가</b>로 잘랐습니다. 한국 영화는 TMDB에 14,546편 있지만
          투표 20개 이상은 1,049편뿐이고, 1980년 이전 1,931편 중에는 9편입니다.
          나머지는 제목만 있고 출연진이 없어 <b>노드는 들어와도 선이 안 생깁니다.</b>
        </p>
        <ul className="bars">
          {decades.map(([d, n]) => (
            <li key={d}>
              <span className="nm">{d}</span>
              <span className="bar"><i style={{ width: `${Math.round((n / maxDec) * 100)}%` }} /></span>
              <span className="num">{n}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>국경을 넘는 인물 {bridges.length}명</h2>
        <p className="hint">
          한국 작품과 외국 작품에 모두 참여한 사람. <b>이들이 두 영화계를 잇는 다리</b>이고,
          “부산행 나온 배우가 마블에도 나왔다”가 성립하는 이유입니다.
        </p>
        <ul className="links">
          {bridges.slice(0, 12).map((b) => (
            <li key={b.id}>
              <Link href={`/browse?person=${encodeURIComponent(b.id)}`}><b>{b.name}</b></Link>
              <span>🇰🇷 {b.ko.slice(0, 2).join(", ")} → {b.fo.slice(0, 2).join(", ")}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>장르 분포</h2>
        <ul className="bars">
          {genres.map(([gg, n]) => (
            <li key={gg}>
              <span className="nm">{gg}</span>
              <span className="bar"><i style={{ width: `${Math.round((n / maxGen) * 100)}%` }} /></span>
              <span className="num">{n}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>연결이 많은 작품</h2>
        <p className="hint">출연·제작진이 많아 다른 작품으로 건너갈 길이 넓은 작품입니다.</p>
        <ul className="links">
          {hubs.map(({ m, deg }) => (
            <li key={m.id}>
              <Link href={`/browse?id=${encodeURIComponent(m.id)}`}>
                <b>{m.title}</b>{m.year ? ` (${m.year})` : ""}
              </Link>
              <span>연결 {deg}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>수상 기록</h2>
        <p className="hint">
          TMDB에는 수상 정보가 없어 <b>위키데이터를 따로 붙였습니다.</b> 제목이 아니라
          TMDB ID(P4947)로 결합해서, 《괴물》 같은 동명이작에서 잘못 이어지지 않습니다.
        </p>
        <p style={{ margin: 0, fontSize: 14.5 }}>
          수상작 <b>{awarded.length}</b>편 · 기록{" "}
          <b>{awarded.reduce((a, m) => a + (m.awards?.length ?? 0), 0)}</b>건
        </p>
      </section>
    </main>
  );
}
