/**
 * 작품 탐색기 — 작품에서 인물로, 인물에서 다시 작품으로 건너다닌다.
 *
 * 서버 컴포넌트 + 링크 이동이라 클라이언트 자바스크립트가 없다.
 * 주소에 ID 가 남으므로 "이 근거를 어디서 봤는지" 를 링크로 공유할 수 있다.
 */
import Link from "next/link";
import { loadGraph } from "@/lib/data.ts";

export const runtime = "nodejs";
export const metadata = { title: "작품 탐색기 — 영화 네비게이터" };

const mHref = (id: string) => `/browse?id=${encodeURIComponent(id)}`;
const pHref = (id: string) => `/browse?person=${encodeURIComponent(id)}`;

export default async function Browse({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; person?: string }>;
}) {
  const { id, person } = await searchParams;
  const g = await loadGraph();

  // ── 인물 화면 ──────────────────────────────────────────────────────
  if (person) {
    const p = g.person(person);
    if (!p) return <main className="wrap"><div className="card err">그런 인물이 없습니다</div></main>;
    const acted = [...new Set(g.filmsOf(p.id, "ACTED_IN").map((e) => e.to))]
      .map((x) => g.movie(x)!).filter(Boolean).sort((a, b) => b.popularity - a.popularity);
    const directed = [...new Set(g.filmsOf(p.id, "DIRECTED").map((e) => e.to))]
      .map((x) => g.movie(x)!).filter(Boolean).sort((a, b) => b.popularity - a.popularity);
    return (
      <main className="wrap">
        <header className="hd">
          <h1>{p.name}</h1>
          <p>{p.department} · 출연 {acted.length}편{directed.length ? ` · 연출 ${directed.length}편` : ""}</p>
        </header>

        {/* 탐색기는 독립된 화면이다. 3D 에는 **주제만** 넘긴다. */}
        <Link className="to3d" href={`/viz?person=${encodeURIComponent(p.id)}`}>
          <span className="to3d-main">{p.name} 이 잇는 작품을 3D로</span>
          <span className="to3d-sub">이 사람을 거쳐야만 이어지는 작품들이 선으로 보입니다</span>
          <span className="to3d-go" aria-hidden="true">→</span>
        </Link>
        {p.awards?.length ? (
          <section className="card">
            <h2>수상 {p.awards.length}건</h2>
            {p.awards.filter((a) => a.forTitle).slice(0, 10).map((a, i) => (
              <p key={i} style={{ margin: "3px 0", fontSize: 13.5 }}>
                🏆 {a.award}{a.year ? ` (${a.year})` : ""} · 《{a.forTitle}》
              </p>
            ))}
          </section>
        ) : null}
        {[["연출", directed], ["출연", acted]].map(([label, list]) =>
          (list as typeof acted).length ? (
            <section key={label as string} className="card">
              <h2>{label as string} {(list as typeof acted).length}편</h2>
              <div className="answers">
                {(list as typeof acted).slice(0, 40).map((m) => (
                  <Link key={m.id} className="ansItem" href={mHref(m.id)}>
                    {m.title} {m.year && <em>{m.year}</em>}
                  </Link>
                ))}
              </div>
            </section>
          ) : null,
        )}
      </main>
    );
  }

  // ── 작품 화면 ──────────────────────────────────────────────────────
  const m = id ? g.movie(id) : null;
  if (!m) {
    const top = [...g.movies.values()].sort((a, b) => b.popularity - a.popularity).slice(0, 60);
    return (
      <main className="wrap">
        <header className="hd">
          <h1>작품 탐색기</h1>
          <p>작품을 고르면 출연·연출을 따라 인물로, 인물에서 다시 다른 작품으로 건너갈 수 있습니다.</p>
        </header>
        <section className="card">
          <h2>인기 작품</h2>
          <div className="answers">
            {top.map((x) => (
              <Link key={x.id} className="ansItem" href={mHref(x.id)}>
                {x.title} {x.year && <em>{x.year}</em>}
              </Link>
            ))}
          </div>
        </section>
      </main>
    );
  }

  const cast = g.creditsOf(m.id, "ACTED_IN")
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).slice(0, 20);
  const crew = [...g.creditsOf(m.id, "DIRECTED"), ...g.creditsOf(m.id, "WROTE")];

  return (
    <main className="wrap">
      <header className="hd">
        <h1>{m.title}{m.year ? ` (${m.year})` : ""}</h1>
        <p>
          {m.originalLanguage === "ko" ? "🇰🇷 한국 " : ""}
          {m.genres.join(" · ")} · ★ {m.voteAverage.toFixed(1)} ({m.voteCount.toLocaleString()}표)
          {m.originalTitle !== m.title && ` · 원제 ${m.originalTitle}`}
        </p>
      </header>

      <Link className="to3d" href={`/viz?movie=${encodeURIComponent(m.id)}`}>
        <span className="to3d-main">《{m.title}》에서 뻗는 관계를 3D로</span>
        <span className="to3d-sub">출연·연출을 거쳐 닿는 다른 작품들. 선 위의 이름이 다리입니다</span>
        <span className="to3d-go" aria-hidden="true">→</span>
      </Link>

      {m.awards?.length ? (
        <section className="card">
          <h2>수상 {m.awards.length}건</h2>
          <p style={{ margin: 0, fontSize: 13.5, color: "var(--gold)" }}>
            {m.awards.slice(0, 12).map((a) => `${a.award}${a.year ? ` (${a.year})` : ""}`).join(" · ")}
          </p>
        </section>
      ) : null}

      <section className="card">
        <h2>줄거리</h2>
        <p style={{ margin: 0, fontSize: 14.5 }}>{m.overview || "줄거리 정보가 없습니다."}</p>
      </section>

      {crew.length > 0 && (
        <section className="card">
          <h2>제작진</h2>
          <div className="answers">
            {[...new Map(crew.map((e) => [e.from, e])).values()].map((e) => {
              const p = g.person(e.from);
              return p ? (
                <Link key={e.from} className="ansItem" href={pHref(p.id)}>
                  {p.name} <em>{e.kind === "DIRECTED" ? "감독" : "각본"}</em>
                </Link>
              ) : null;
            })}
          </div>
        </section>
      )}

      <section className="card">
        <h2>출연 {cast.length}명</h2>
        <p className="hint">이름을 누르면 그 배우의 다른 작품으로 건너갑니다 — 이게 이 도구가 건너는 다리입니다.</p>
        <div className="answers">
          {cast.map((e) => {
            const p = g.person(e.from);
            return p ? (
              <Link key={e.from} className="ansItem" href={pHref(p.id)}>
                {p.name} {e.as && <em>{e.as}</em>}
              </Link>
            ) : null;
          })}
        </div>
      </section>
    </main>
  );
}
