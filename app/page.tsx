"use client";

import Link from "next/link";
import stats from "@/data/stats.json";
import { useEffect, useState } from "react";
import { VIZ_EVENT } from "./VizDock.tsx";
import { storedKey } from "./Settings.tsx";
import type { AskResult, EvidenceMovie, PathStep } from "@/lib/ask.ts";

type Payload = AskResult & { answer: string | null; llm: { enabled: boolean; reason: string; model?: string } };

const ROUTE_LABEL: Record<string, string> = {
  lookup: "작품·인물 조회",
  filmography: "인물의 작품",
  bridge: "다리 건너기",
  similar: "유사 작품",
  award: "수상",
  out_of_scope: "범위 밖",
};

// 예시는 **이 도구가 무엇을 해 주는지 보여 주는 것**으로 고른다.
// 마지막 둘은 일부러 답이 없는 질문이다 — 지어내지 않는 것도 기능이다.
const SAMPLES = [
  "송강호와 이선균이 함께 출연한 영화는?",
  "기생충에서 기택 역을 맡은 배우는?",
  "기생충에서 기우를 연기한 배우가 출연한 좀비 영화는?",
  "추격자, 황해, 곡성에 모두 출연한 배우는?",
  "파묘 어디서 볼 수 있어?",
];

function Chain({ path }: { path: PathStep[] }) {
  if (!path.length) return null;
  return (
    <div className="chain">
      <span className="node seed">{path[0].fromLabel}</span>
      {path.map((s, i) => (
        <span key={i} style={{ display: "contents" }}>
          <span className="arrow">─<b>{s.via}</b>─▶</span>
          <span className="node">{s.toLabel}</span>
        </span>
      ))}
    </div>
  );
}

function Film({ f }: { f: EvidenceMovie }) {
  const [open, setOpen] = useState(false);
  const long = f.overview.length > 120;
  return (
    <article className="film">
      <div className="top">
        <span className="tag">{f.korean ? "🇰🇷 한국" : "해외"}</span>
        <span className={f.isSeed ? "tag seed" : "tag"}>{f.isSeed ? "출발점" : "건너간 곳"}</span>
      </div>
      <h3>
        <Link href={`/browse?id=${encodeURIComponent(f.id)}`}>
          {f.title}{f.year ? ` (${f.year})` : ""}
        </Link>
      </h3>
      <div className="sub">
        <span>★ {f.voteAverage.toFixed(1)}</span>
        <span>{f.genres.join(" · ")}</span>
      </div>
      {f.awards.length > 0 && (
        <p className="awards">
          🏆 {f.awards.slice(0, 3).map((a) => `${a.award}${a.year ? ` (${a.year})` : ""}`).join(" · ")}
        </p>
      )}
      {f.path.length > 0 && <Chain path={f.path} />}
      <p className={long && !open ? "body clip" : "body"}>{f.overview}</p>
      {long && (
        <button className="more" onClick={() => setOpen((v) => !v)}>
          {open ? "접기" : "줄거리 더 보기"}
        </button>
      )}
    </article>
  );
}

export default function Home() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<Payload | null>(null);

  async function run(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // 직전 결과를 함께 보낸다 — "그중에" 가 무엇을 가리키는지 서버가 알아야 한다
        body: JSON.stringify({
          question: text,
          // 브라우저에 저장된 키를 이 요청에만 실어 보낸다
          apiKey: storedKey(),
          previous: res && res.evidence.length
            ? { question: res.question, movieIds: res.evidence.map((e) => e.id) }
            : undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error ?? "요청이 실패했습니다");
      setRes(data as Payload);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRes(null);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 답이 나오면 오른쪽 3D 패널에 알린다.
   * 질문의 답은 클라이언트 상태라 주소가 바뀌지 않으므로, 주소 대신 이벤트로 넘긴다.
   */
  useEffect(() => {
    if (!res) return;
    const detail = res.refused || res.premiseBroken ? null : {
      title: res.question,
      nodes: res.evidence.map((e) => ({
        id: e.id, label: e.title, hop: Math.min(e.path.length, 3),
        korean: e.korean, isSeed: e.isSeed,
        poster: e.posterPath, year: e.year,
      })),
      edges: (() => {
        const seen = new Set<string>();
        const out: { from: string; to: string; via: string }[] = [];
        for (const e of res.evidence) {
          for (const s of e.path) {
            const k = `${s.from}>${s.to}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ from: s.from, to: s.to, via: s.via });
          }
        }
        return out;
      })(),
    };
    window.dispatchEvent(new CustomEvent(VIZ_EVENT, { detail }));
  }, [res]);

  const hasAnswer =
    res && !res.refused && !res.premiseBroken &&
    (res.cast.length > 0 || res.characters.length > 0 ||
      res.commonMovies.length > 0 || res.commonPeople.length > 0);

  return (
    <main className="wrap">
      <header className="hd">
        <h1>영화 네비게이터</h1>
        <p>
          {/* 숫자는 build-graph 가 만든 stats.json 에서 온다 — 손으로 적으면 낡는다 */}
          한국 영화 {stats.korean.toLocaleString()}편과 그 인물이 참여한 외국 영화{" "}
          {stats.foreign.toLocaleString()}편을 그래프로 이었습니다.
          <b> 줄거리에 없는 답</b>을 인물이라는 다리를 건너 찾습니다.
        </p>
      </header>

      <form className="askbox" onSubmit={(e) => { e.preventDefault(); void run(q); }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="예) 송강호와 이선균이 함께 출연한 영화는?"
          aria-label="질문"
        />
        <button type="submit" disabled={busy || !q.trim()}>{busy ? "찾는 중…" : "찾기"}</button>
      </form>

      <div className="samples">
        <span>예시</span>
        {SAMPLES.map((s) => (
          <button key={s} type="button" onClick={() => { setQ(s); void run(s); }}>{s}</button>
        ))}
      </div>

      {err && <div className="card err"><p style={{ margin: 0 }}>{err}</p></div>}

      {res && (
        <section>
          <div className="meta">
            <span className="badge">{res.followUp ? "이어서" : ROUTE_LABEL[res.route] ?? res.route}</span>
            <span className="why">{res.reason}</span>
          </div>

          {res.followUp && (
            <p className="followup">
              「{res.followUp.of}」의 결과에서 <b>{res.followUp.filters.join(" · ")}</b> 추렸습니다
              — 새로 찾지 않았습니다
            </p>
          )}
          {res.followUpGaveUp && <p className="followup gave">{res.followUpGaveUp}</p>}

          {res.refused ? (
            <div className="card stop">
              <h2>답하지 않습니다</h2>
              <p>{res.refusalReason}</p>
              <p className="sub">근거를 찾지 못했으므로 <b>LLM을 호출하지 않았습니다.</b> 호출하지 않으면 지어낼 기회가 없습니다.</p>
            </div>
          ) : res.premiseBroken ? (
            // 거절과 다르다 — **찾아본 결과** 전제가 사실이 아닌 경우다.
            <div className="card warn">
              <h2>질문의 전제가 사실과 다릅니다</h2>
              <p dangerouslySetInnerHTML={{ __html: (res.premiseReason ?? "").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>") }} />
              {res.premiseInstead && <p className="sub">{res.premiseInstead}</p>}
              <p className="sub">범위 밖이라는 뜻이 아니라, <b>찾아본 결과</b>입니다.</p>
            </div>
          ) : (
            <>
              {hasAnswer && (
                <div className="card">
                  <h2>답</h2>
                  <div className="answers">
                    {res.cast.map((c) => (
                      <Link key={`${c.movie?.id ?? ""}${c.id}`} className={c.role === "출연" ? "ansItem" : "ansItem crew"}
                        href={`/browse?person=${encodeURIComponent(c.id)}`}>
                        {c.name} <em>{c.role === "출연" ? (c.as ?? "출연") : c.role}</em>
                        {/* 동명이작일 때만 어느 작품인지 붙는다 — 한 편뿐이면 조용하다 */}
                        {c.movie && <em className="dup">《{c.movie.title}》 {c.movie.year}</em>}
                      </Link>
                    ))}
                    {res.characters.map((c) => (
                      <span key={`${c.person}${c.movie}`} className="ansItem">
                        {c.person} <em>《{c.movie}》 {c.as}</em>
                      </span>
                    ))}
                    {res.commonMovies.map((m) => (
                      <Link key={m.id} className="ansItem" href={`/browse?id=${encodeURIComponent(m.id)}`}>
                        《{m.title}》 {m.year && <em>{m.year}</em>}
                      </Link>
                    ))}
                    {res.commonPeople.filter((p) => p.acted).map((p) => (
                      <span key={p.name} className="ansItem">{p.name}</span>
                    ))}
                  </div>
                </div>
              )}

              {res.personAwards.length > 0 && (
                <div className="card">
                  <h2>수상</h2>
                  {res.personAwards.map((a, i) => (
                    <p key={i} style={{ margin: "3px 0", fontSize: 13.5 }}>
                      🏆 {a.person} — {a.award}{a.year ? ` (${a.year})` : ""} {a.forTitle && <>· 《{a.forTitle}》</>}
                    </p>
                  ))}
                </div>
              )}

              {/* 답변은 근거 위에 둔다. 다만 근거를 지우지 않는다 —
                  모델이 무엇을 보고 말했는지 확인할 수 있어야 한다. */}
              {res.answer ? (
                <div className="card answer">
                  <h2>답변</h2>
                  <p>{res.answer}</p>
                  <p className="src">
                    아래 <b>근거 {res.evidence.length}편</b>만 보고 쓴 문장입니다
                    {res.llm.model && ` · ${res.llm.model}`}
                  </p>
                </div>
              ) : (
                <div className="card pending">
                  <h2>답변 문장</h2>
                  <p>{res.llm.reason}</p>
                </div>
              )}


              <div className="films">
                <h2>근거 {res.evidence.length}편</h2>
                <p className="hint">
                  출발점 {res.seeds.length}곳에서 인물을 건너 모았습니다.
                  {res.dropped > 0 && ` 예산(10편)으로 잘라낸 것 ${res.dropped}편.`}
                </p>
                {res.evidence.map((f) => <Film key={f.id} f={f} />)}
              </div>
            </>
          )}
        </section>
      )}
    </main>
  );
}
