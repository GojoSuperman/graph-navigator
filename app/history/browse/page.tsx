/**
 * 인물 탐색기 — 인물에서 조직으로, 조직에서 다시 인물로 건너다닌다.
 *
 * 영화 탐색기와 같은 원칙 — **서버 컴포넌트 + 링크 이동**이라 클라이언트
 * 자바스크립트가 없고, 주소에 id 가 남아 "이 근거를 어디서 봤는지" 를 공유할 수 있다.
 *
 * 시대는 **필터로만** 쓴다. 탐색에는 쓰지 않는다 — 같은 시대라는 이유로 이어 주면
 * 다리가 아니라 지름길이 된다(설계서 §4).
 */
import Link from "next/link";
import { loadHistoryGraph } from "@/lib/history/data.ts";
import { ERAS, KIND_LABEL, type EdgeKind } from "@/lib/history/config.ts";

export const runtime = "nodejs";
export const metadata = { title: "인물 탐색기 — 그래프 네비게이터" };

const href = (id: string) => `/history/browse?id=${encodeURIComponent(id)}`;
const eraHref = (era: string) => `/history/browse?era=${encodeURIComponent(era)}`;
const TYPE_LABEL: Record<string, string> = { Person: "인물", Organization: "조직", Event: "사건" };

export default async function Browse({
  searchParams,
}: { searchParams: Promise<{ id?: string; era?: string }> }) {
  const { id, era } = await searchParams;
  const g = await loadHistoryGraph();

  // ── 노드 하나 ──────────────────────────────────────────────────────
  if (id) {
    const n = g.node(id);
    if (!n) return <main className="wrap"><div className="card err">그런 개체가 없습니다</div></main>;

    // 관계별로 묶어 보여 준다. 방향이 의미를 가지므로 **나가는 것과 들어오는 것을 나눈다**
    const groups = new Map<string, { other: string; quote: string | null; doc: string | null }[]>();
    for (const { edge, other, dir } of g.neighbors(n.id)) {
      const k = `${dir === "out" ? "" : "◀ "}${KIND_LABEL[edge.kind as EdgeKind] ?? edge.kind}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push({
        other, quote: edge.quotes[0] ?? null, doc: edge.docs[0] ?? null,
      });
    }

    return (
      <main className="wrap">
        <header className="hd">
          <h1>{n.id}</h1>
          <p>
            {TYPE_LABEL[n.type] ?? n.type}
            {n.era && <> · <Link href={eraHref(n.era)}>{n.era}</Link></>}
            {" · "}연결 {n.degree}
            {g.hubs.has(n.id) && <> · <b title="탐색에서 경유가 막힌 노드">허브</b></>}
            {n.aliases.length > 0 && <> · 별칭 {n.aliases.join(", ")}</>}
          </p>
        </header>

        {[...groups].sort((a, b) => b[1].length - a[1].length).map(([kind, list]) => (
          <section key={kind} className="card">
            <h2>{kind} {list.length}건</h2>
            <p className="hint">이름을 누르면 그쪽으로 건너갑니다 — 이게 이 도구가 건너는 다리입니다.</p>
            <ul className="triples">
              {list.slice(0, 40).map((e, i) => (
                <li key={i}>
                  <Link className="node" href={href(e.other)}>{e.other}</Link>
                  {e.quote && <div className="quote">“{e.quote}”</div>}
                  {e.doc && <div className="src-doc">위키백과 《{e.doc}》</div>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
    );
  }

  // ── 목록 (시대 필터) ────────────────────────────────────────────────
  const all = [...g.nodes.values()];
  const shown = (era ? all.filter((n) => n.era === era) : all.filter((n) => n.era))
    .sort((a, b) => b.degree - a.degree);

  return (
    <main className="wrap">
      <header className="hd">
        <h1>인물 탐색기</h1>
        <p>
          노드 {all.length.toLocaleString()} · 관계 {g.edges.length.toLocaleString()} ·
          문서를 가진 개체 {all.filter((n) => n.era).length}
        </p>
      </header>

      <section className="card">
        <h2>시대</h2>
        <div className="answers">
          <Link className={`ansItem${!era ? " on" : ""}`} href="/history/browse">전체</Link>
          {ERAS.map((e) => (
            <Link key={e} className={`ansItem${era === e ? " on" : ""}`} href={eraHref(e)}>
              {e} <em>{all.filter((n) => n.era === e).length}</em>
            </Link>
          ))}
        </div>
        <p className="hint">
          시대는 <b>필터로만</b> 씁니다. 탐색에는 쓰지 않습니다 — 같은 시대라는 이유로
          이어 주면 다리가 아니라 지름길이 됩니다.
        </p>
      </section>

      <section className="card">
        <h2>{era ?? "전체"} {shown.length}건 <span className="hint">연결이 많은 순</span></h2>
        <div className="answers">
          {shown.map((n) => (
            <Link key={n.id} className="ansItem" href={href(n.id)}>
              {n.id} <em>{TYPE_LABEL[n.type]} {n.degree}</em>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
