/**
 * 지도 — 말뭉치가 어떻게 생겼는지 한눈에.
 *
 * 영화 지도와 같은 자리다. 숫자는 전부 **LLM 없이** 그래프에서 직접 센 것이다.
 * 특히 '시대를 가로지르는 개체' 는 영화의 '국경을 넘는 인물' 에 해당한다 —
 * 수집 전략(시대별 시드 + 2홉 확장)이 실제로 다리를 만들어 냈는지를 보여 준다.
 */
import Link from "next/link";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadHistoryGraph } from "@/lib/history/data.ts";
import { ERAS, KIND_LABEL, BUDGET, type EdgeKind, type Era } from "@/lib/history/config.ts";

export const runtime = "nodejs";
export const metadata = { title: "지도 — 그래프 네비게이터" };

const href = (id: string) => `/history/browse?id=${encodeURIComponent(id)}`;
const TYPE_LABEL: Record<string, string> = { Person: "인물", Organization: "조직", Event: "사건" };

export default async function HistoryMap() {
  const g = await loadHistoryGraph();
  const manifest = JSON.parse(await readFile(
    join(process.cwd(), "data", "history", "manifest.json"), "utf-8"));

  const nodes = [...g.nodes.values()];
  const withDoc = nodes.filter((n) => n.era);

  // ── 시대별 문서·엣지 ────────────────────────────────────────────────
  const eraDocs = new Map<Era, number>(ERAS.map((e) => [e, 0]));
  for (const n of withDoc) eraDocs.set(n.era as Era, (eraDocs.get(n.era as Era) ?? 0) + 1);
  /**
   * 시대별 관계 수 — **한쪽이라도 그 시대면 센다.**
   *
   * 처음엔 "양끝이 모두 그 시대" 로 셌더니 23·20·52·53 이라는 작은 수가 나왔다.
   * 노드 대부분에는 시대가 없다 — **문서를 가진 것만** 시대가 붙어서, 대부분의 관계는
   * 한쪽 끝에 시대가 없다(1,183개). 그렇게 세면 관계의 87%가 표에서 사라진다.
   */
  const eraEdges = new Map<Era, number>(ERAS.map((e) => [e, 0]));
  let crossEra = 0, sameEra = 0, halfEra = 0, noEra = 0;
  const crossers: { id: string; eras: Era[]; deg: number }[] = [];
  for (const e of g.edges) {
    const a = g.node(e.from)?.era as Era | null, b = g.node(e.to)?.era as Era | null;
    for (const x of new Set([a, b])) if (x) eraEdges.set(x, (eraEdges.get(x) ?? 0) + 1);
    if (a && b) (a === b ? sameEra++ : crossEra++);
    else if (a || b) halfEra++;
    else noEra++;
  }
  const maxDocs = Math.max(...eraDocs.values());
  const maxEdges = Math.max(...eraEdges.values());

  // ── 시대를 가로지르는 개체 — 영화의 '국경을 넘는 인물' 자리 ─────────
  for (const n of nodes) {
    const eras = new Set<Era>();
    for (const { other } of g.neighbors(n.id)) {
      const e = g.node(other)?.era as Era | null;
      if (e) eras.add(e);
    }
    if (eras.size >= 2) crossers.push({ id: n.id, eras: [...eras], deg: n.degree });
  }
  crossers.sort((a, b) => b.eras.length - a.eras.length || b.deg - a.deg);

  /**
   * **시대마다 몫을 준다.**
   *
   * 처음엔 (시대 수 → 연결 수) 로만 정렬했더니 목록 상위가 전부 근대였다.
   * 연결이 많은 것이 죄다 근대 인물이기 때문이다(이승만 89 · 임시정부 45).
   * 임진왜란(24)·흥선대원군(18)·이순신(14) 같은 조선의 다리가 통째로 밀렸다.
   * 수집에서 시대별 할당을 둔 것과 같은 이유로, 여기서도 시대마다 몫을 준다.
   */
  const PER_ERA_SHOW = 3;
  const shown = new Set<string>();
  const balanced: typeof crossers = [];
  for (const era of ERAS) {
    for (const c of crossers.filter((x) => x.eras.includes(era)).slice(0, PER_ERA_SHOW)) {
      if (!shown.has(c.id)) { shown.add(c.id); balanced.push(c); }
    }
  }
  /** 조선 안에서만 잇는 개체 — 근대와 안 이어져 위 목록에서 늘 밀린다 */
  const joseonOnly = crossers.filter((c) =>
    c.eras.every((e) => e === "조선 전·중기" || e === "조선 후기"));

  // ── 관계 분포 ───────────────────────────────────────────────────────
  const byKind = new Map<string, number>();
  for (const e of g.edges) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  const kinds = [...byKind.entries()].sort((a, b) => b[1] - a[1]);
  const maxKind = kinds[0]?.[1] ?? 1;

  const hubs = nodes.slice().sort((a, b) => b.degree - a.degree).slice(0, 12);
  const quoteCount = g.edges.reduce((s, e) => s + e.quotes.length, 0);
  const multiQuote = g.edges.filter((e) => e.quotes.length > 1).length;
  const tail = nodes.filter((n) => n.degree <= 1).length;

  return (
    <main className="wrap">
      <header className="hd">
        <h1>지도</h1>
        <p>
          위키백과 <b>{manifest.count}건</b>에서 뽑은 노드 {nodes.length.toLocaleString()} ·
          관계 {g.edges.length.toLocaleString()} · 근거 문장 {quoteCount.toLocaleString()}.
          아래 숫자는 전부 <b>LLM 없이</b> 그래프에서 직접 셌습니다.
        </p>
      </header>

      <section className="card">
        <h2>수집 범위 — 시대마다 {manifest.target / ERAS.length}건씩</h2>
        <p className="hint">
          600년을 한 통에 넣고 상위부터 채우면 <b>문서가 많은 현대사로 쏠립니다.</b>
          시대마다 몫을 따로 두고, 후보도 시대별로 나눠 뽑았습니다.
          처음엔 전체에서 상위 900건을 잘랐는데 조선 후기가 통째로 밀려나 16건에서 멈췄습니다.
        </p>
        <ul className="bars">
          {ERAS.map((e) => (
            <li key={e}>
              <span className="nm">{e}</span>
              <span className="bar"><i style={{ width: `${Math.round((eraDocs.get(e)! / maxDocs) * 100)}%` }} /></span>
              <span className="num">{eraDocs.get(e)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>시대를 가로지르는 개체 {crossers.length}개</h2>
        <p className="hint">
          두 시대 이상의 문서와 이어진 개체. <b>이들이 시대를 잇는 다리</b>이고,
          “정약용의 학맥을 이은 사람이 참여한 개혁은?” 같은 질문이 성립하는 이유입니다.
          양끝에 시대가 다 붙은 관계 {sameEra + crossEra}개 중 <b>{crossEra}개({Math.round(crossEra / (sameEra + crossEra) * 100)}%)가
          시대를 가로지릅니다.</b> 설계서는 이 다리가 얇을 것으로 예상했는데, 생각만큼
          얇지 않았습니다.
        </p>
        <ul className="links">
          {balanced.map((c) => (
            <li key={c.id}>
              <Link href={href(c.id)}><b>{c.id}</b></Link>
              <span>{c.eras.join(" · ")} · 연결 {c.deg}</span>
            </li>
          ))}
        </ul>
        <p className="hint">
          시대마다 {PER_ERA_SHOW}개씩 뽑았습니다. 연결 수로만 줄 세우면
          <b> 목록이 전부 근대로 찹니다</b> — 연결이 많은 것이 죄다 근대 인물이기 때문입니다
          (이승만 89 · 임시정부 45). 그러면 임진왜란·흥선대원군·이순신 같은
          조선의 다리가 안 보입니다.
        </p>
      </section>

      <section className="card">
        <h2>조선 안에서만 잇는 개체 {joseonOnly.length}개</h2>
        <p className="hint">
          조선 전·중기와 후기를 잇되 <b>근대와는 안 이어진</b> 개체입니다.
          연결 수로 줄 세우면 늘 밀리므로 따로 냅니다.
        </p>
        <ul className="links">
          {joseonOnly.slice(0, 10).map((c) => (
            <li key={c.id}>
              <Link href={href(c.id)}><b>{c.id}</b></Link>
              <span>{c.eras.join(" · ")} · 연결 {c.deg}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>관계 분포</h2>
        <p className="hint">
          스키마로 <b>6종만</b> 뽑게 제한했습니다. <code>AFFECTED</code>(영향)가 유독 적은데,
          “그 사건으로 조직이 해산·수립됐다”고 <b>명시한 문장만</b> 인정하도록 정의를 좁힌 결과입니다.
        </p>
        <ul className="bars">
          {kinds.map(([k, n]) => (
            <li key={k}>
              <span className="nm">{KIND_LABEL[k as EdgeKind] ?? k}</span>
              <span className="bar"><i style={{ width: `${Math.round((n / maxKind) * 100)}%` }} /></span>
              <span className="num">{n}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>시대별 관계 밀도</h2>
        <p className="hint">
          문서는 시대마다 35건으로 같은데 <b>관계는 4배 넘게 차이가 납니다.</b>
          위키백과의 서술 밀도가 근현대로 갈수록 촘촘하기 때문입니다.
          한쪽 끝이라도 그 시대면 셌습니다 — 노드 {nodes.length.toLocaleString()}개 중
          시대가 붙은 것은 <b>문서를 가진 {withDoc.length}개뿐</b>이라, 양끝 모두를
          요구하면 관계의 87%가 표에서 사라집니다.
        </p>
        <ul className="bars">
          {ERAS.map((e) => (
            <li key={e}>
              <span className="nm">{e}</span>
              <span className="bar"><i style={{ width: `${Math.round((eraEdges.get(e)! / maxEdges) * 100)}%` }} /></span>
              <span className="num">{eraEdges.get(e)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>허브 — 탐색에서 <b>경유가 막힌</b> {BUDGET.hubTop}개</h2>
        <p className="hint">
          연결이 많은 노드를 지나가게 두면 근현대 인물 전원이 2홉 이웃이 됩니다.
          다리가 아니라 <b>지름길</b>이라 경유를 막습니다 — 다만 목적지로는 허용합니다.
          <b> 재 보니 재현율에 차이가 없었습니다</b>(막지 않아도 85%). 근거가 약한 결정이라
          8개만 남겼습니다.
        </p>
        <ul className="links">
          {hubs.map((n, i) => (
            <li key={n.id}>
              <Link href={href(n.id)}>
                <b>{n.id}</b>
              </Link>
              <span>
                {TYPE_LABEL[n.type]} · 연결 {n.degree}
                {i < BUDGET.hubTop ? " · 경유 금지" : ""}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>한계 — 스키마가 근대 정치사에 치우쳤다</h2>
        <p className="hint">
          문서는 시대마다 35건으로 같은데 관계는 <b>구한말·일제 670 vs 조선 전·중기 154</b>로
          4배 넘게 벌어집니다. 위키백과 서술 밀도 차이도 있지만, <b>더 큰 원인은 스키마입니다.</b>
        </p>
        <ul className="bars">
          {ERAS.map((e) => {
            const m = new Map<string, number>();
            for (const ed of g.edges) {
              for (const x of new Set([g.node(ed.from)?.era, g.node(ed.to)?.era])) {
                if (x === e) m.set(ed.kind, (m.get(ed.kind) ?? 0) + 1);
              }
            }
            const top = [...m].sort((a, b) => b[1] - a[1]).slice(0, 3);
            return (
              <li key={e}>
                <span className="nm">{e}</span>
                <span className="num" style={{ width: "auto", textAlign: "left", opacity: .85 }}>
                  {top.map(([k, n]) => `${KIND_LABEL[k as EdgeKind] ?? k} ${n}`).join(" · ")}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="hint">
          관계 6종 중 <b>설립·소속·이끔 셋이 조직을 전제</b>합니다. 근대에는 신민회·임시정부·
          정당이 있지만 <b>조선에는 근대적 조직이 드뭅니다.</b> 조선 인물의 주된 관계는
          관직·혼맥·사화·붕당인데 — <b>관직은 정제 단계에서 일부러 뺐습니다</b>
          (《전라도관찰사》는 자리이지 조직이 아니므로). 맞는 판단이었지만,
          그 결과 <b>조선 인물의 주 관계가 통째로 빠졌습니다.</b> 혼맥·사화는 애초에
          스키마에 없습니다. 스키마를 근대 정치사에 맞춰 짜놓고 600년에 적용한 셈입니다.
        </p>
      </section>

      <section className="card">
        <h2>근거는 얼마나 두꺼운가</h2>
        <p className="hint">
          모든 관계에는 <b>위키백과 원문 문장</b>이 붙어 있습니다. 문장이 원문에 실재하는지
          코드가 대조해 통과 못 한 것은 버렸습니다 — 제안 2,937개 중 채택 2,256개(77%).
        </p>
        <ul className="links">
          <li><b>근거 문장 {quoteCount.toLocaleString()}개</b><span>관계 {g.edges.length.toLocaleString()}개에 붙음</span></li>
          <li><b>여러 문서가 말한 사실 {multiQuote}개</b><span>근거가 2개 이상인 관계 — 더 믿을 만함</span></li>
          <li><b>연결이 1개뿐인 노드 {tail}개</b><span>전체의 {Math.round(tail / nodes.length * 100)}% · 탐색에는 거의 안 쓰임</span></li>
          <li><b>문서를 가진 개체 {withDoc.length}개</b><span>나머지 {(nodes.length - withDoc.length).toLocaleString()}개는 <b>관계에서만 등장</b> — 시대·요약이 없음</span></li>
          <li><b>양끝이 다 문서인 관계 {sameEra + crossEra}개</b><span>한쪽만 {halfEra.toLocaleString()} · 양쪽 다 아님 {noEra}</span></li>
        </ul>
      </section>
    </main>
  );
}
