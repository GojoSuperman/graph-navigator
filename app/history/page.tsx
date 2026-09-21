"use client";

/**
 * 한국사 질문 화면.
 *
 * 과제 요구 — "답변과 함께 **탄 경로 · 근거 삼중항 · 출처 문서**를 보여 준다".
 * 셋을 접어 두지 않고 한 화면에 같이 띄운다. 답변만 보이면 무엇을 근거로 한
 * 말인지 알 수 없고, 그러면 이 도구를 쓸 이유가 없다.
 */

import { useEffect, useState } from "react";
import { storedKey } from "../Settings.tsx";
import { VIZ_EVENT } from "../VizDock.tsx";

const KIND_LABEL: Record<string, string> = {
  PARTICIPATED_IN: "참여", FOUNDED: "설립", MEMBER_OF: "소속",
  LED: "이끔", AFFECTED: "영향", STUDIED_UNDER: "사사",
};

// 마지막 둘은 일부러 답이 없는 질문이다 — **지어내지 않는 것도 기능이다.**
const SAMPLES = [
  "안창호가 세운 조직은?",
  "김규식이 파리강화회의 대표로 파견된 단체에 함께 속했던 인물은?",
  "규장각을 세운 왕이 만든 호위 군대는?",
  "임진왜란으로 건물이 불타 교육이 중단된 기관은?",
  "송강호가 출연한 영화는?",
  "오늘 서울 날씨 어때?",
];

interface Triple { from: string; kind: string; to: string; quote: string | null; doc: string | null }
interface Payload {
  question: string; answer: string | null;
  llm: { enabled: boolean; reason: string; model?: string };
  routeKind: string; reason: string; refused: boolean; refusalReason: string | null;
  trace: string[]; seeds: string[]; paths: string[]; triples: Triple[]; sources: string[];
  counts: { evidence: number; triples: number; dropped: number; blocked: number };
  viz?: { nodes: any[]; edges: any[] };
  error?: string;
}

export default function HistoryPage() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<Payload | null>(null);
  const [err, setErr] = useState("");

  /**
   * 오른쪽 3D 에 **답을 찾은 길**을 그린다.
   * 경로를 기록하는 이유가 제시하기 위해서인데, 화면 한 곳에만 글로 두면
   * 여러 갈래가 한눈에 안 들어온다.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(VIZ_EVENT, {
      detail: r?.viz?.nodes.length
        ? { title: r.question, nodes: r.viz.nodes, edges: r.viz.edges }
        : null,
    }));
  }, [r]);

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setBusy(true); setErr(""); setR(null); setQ(question);
    try {
      const res = await fetch("/api/history/ask", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, apiKey: storedKey() }),
      });
      const j = (await res.json()) as Payload;
      if (j.error) setErr(j.error); else setR(j);
    } catch (e) {
      setErr(`요청 실패 — ${(e as Error).message}`);
    } finally { setBusy(false); }
  }

  return (
    <main className="wrap">
      {/* 영화 화면과 **같은 뼈대**를 쓴다 — header.hd · form.askbox · .samples.
          도메인이 달라도 쓰는 사람이 같은 앱으로 느껴야 한다 */}
      <header className="hd">
        <h1>🏛 한국사 네비게이터</h1>
        <p>
          조선(1392)부터 현재까지 위키백과 140건에서 <b>인물·조직·사건</b> 1,135개와
          관계 1,620개를 뽑았습니다. <b>한 문서만 읽어서는 안 나오는 답</b>을
          다리를 건너 찾습니다.
        </p>
      </header>

      <form className="askbox" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="예) 안창호가 세운 조직은?"
          aria-label="질문"
          autoFocus
        />
        <button type="submit" disabled={busy || !q.trim()}>{busy ? "찾는 중…" : "찾기"}</button>
      </form>

      <div className="samples">
        <span>예시</span>
        {SAMPLES.map((s) => <button key={s} type="button" onClick={() => ask(s)}>{s}</button>)}
      </div>

      {err && <p className="err">{err}</p>}

      {r && (
        <>
          {/* 어디를 지나 여기까지 왔는가 — 거절이면 어느 노드에서 끊겼는지가 보인다 */}
          <p className="trace">
            경유 <code>{r.trace.join(" → ")}</code> · 라우팅 <b>{r.routeKind}</b> — {r.reason}
          </p>

          {r.refused ? (
            <section className="card stop">
              <h2>답하지 않습니다</h2>
              <p>{r.refusalReason}</p>
              <p className="sub">근거가 없으면 지어내지 않습니다 — LLM 을 호출하지도 않았습니다.</p>
            </section>
          ) : (
            <>
              {r.answer ? (
                <section className="card">
                  <h2>답변</h2>
                  <p className="answer-text">{r.answer}</p>
                </section>
              ) : (
                <section className="card warn">
                  <h2>근거만 표시합니다</h2>
                  <p>{r.llm.reason}</p>
                </section>
              )}

              <section className="card">
                <h2>탄 경로</h2>
                <p className="hint">
                  씨앗 <b>{r.seeds.join(" · ")}</b> 에서 출발해 실제로 건넌 길입니다.
                </p>
                {r.paths.length ? (
                  <div className="chain-list">
                    {r.paths.map((p, i) => <div key={i} className="chain-row">{p}</div>)}
                  </div>
                ) : <p className="hint">씨앗이 곧 답이라 건넌 다리가 없습니다.</p>}
              </section>

              <section className="card">
                <h2>근거 삼중항 · 출처</h2>
                <p className="hint">
                  근거 {r.counts.evidence}개 · 삼중항 {r.counts.triples}개
                  {r.counts.blocked > 0 && <> · 허브 통과 금지 {r.counts.blocked}회</>}
                  {r.counts.dropped > 0 && <> · 예산으로 버림 {r.counts.dropped}</>}
                </p>
                <ul className="triples">
                  {r.triples.map((t, i) => (
                    <li key={i}>
                      <span className="node">{t.from}</span>
                      <span className="arrow">─<b>{KIND_LABEL[t.kind] ?? t.kind}</b>─▶</span>
                      <span className="node">{t.to}</span>
                      {t.quote && <div className="quote">“{t.quote}”</div>}
                      {t.doc && <div className="src-doc">위키백과 《{t.doc}》</div>}
                    </li>
                  ))}
                </ul>
              </section>

              <section className="card">
                <h2>출처 문서 {r.sources.length}건</h2>
                <p className="hint">{r.sources.join(" · ")}</p>
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}
