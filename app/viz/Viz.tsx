"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SceneApi, VizEdge, VizNode, FieldData } from "./scene.ts";
import type { AskResult } from "@/lib/ask.ts";

type Payload = AskResult & { answer: string | null; llm: { reason: string } };
type Mode = "focus" | "field";

const MODES: { id: Mode; name: string; hint: string }[] = [
  { id: "focus", name: "집중형", hint: "질문에 쓰인 작품만 홉 거리별로" },
  { id: "field", name: "전경형", hint: "말뭉치를 배경에 깔고 경로만 점화" },
];

const SAMPLES = [
  "송강호와 이선균이 함께 출연한 영화는?",
  "기생충에서 기우를 연기한 배우가 출연한 좀비 영화는?",
  "마동석이 이터널스 이전에 찍은 좀비 영화는?",
  "추격자, 황해, 곡성에 모두 출연한 배우는?",
];

/** ask 응답 → 3D 가 필요한 것만. 홉 거리는 경로 길이에서 나온다. */
function toViz(res: Payload): { nodes: VizNode[]; edges: VizEdge[]; refused: boolean } {
  const nodes: VizNode[] = res.evidence.map((e) => ({
    id: e.id,
    label: e.title,
    hop: Math.min(e.path.length, 3),
    korean: e.korean,
    isSeed: e.isSeed,
  }));
  const seen = new Set<string>();
  const edges: VizEdge[] = [];
  for (const e of res.evidence) {
    for (const s of e.path) {
      const k = `${s.from}>${s.to}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push({ from: s.from, to: s.to, via: s.via });
    }
  }
  return { nodes, edges, refused: res.refused || res.premiseBroken };
}

/**
 * 3D 는 네 가지 입구를 받는다. 세 페이지가 서로를 몰라도 되도록,
 * 각자 **주제만** 주소에 실어 보낸다.
 *   ?q=질문      질문 화면에서 — 답까지 건넌 다리
 *   ?movie=…     작품 탐색기에서 — 그 작품에서 뻗는 관계
 *   ?person=…    탐색기·지도에서 — 그 사람이 잇는 작품들
 */
const fromUrl = () => {
  if (typeof window === "undefined") return { mode: "focus" as Mode, q: "", movie: "", person: "" };
  const p = new URLSearchParams(location.search);
  return {
    mode: (p.get("mode") === "field" ? "field" : "focus") as Mode,
    q: (p.get("q") ?? "").trim(),
    movie: (p.get("movie") ?? "").trim(),
    person: (p.get("person") ?? "").trim(),
  };
};

export default function Viz() {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<SceneApi | null>(null);
  const fieldRef = useRef<FieldData | null>(null);

  const [mode, setMode] = useState<Mode>("focus");
  const [ready, setReady] = useState(false);
  const [q, setQ] = useState(SAMPLES[0]);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Payload | null>(null);
  /** 질문이 아니라 주제로 들어온 경우 — 무대에 띄울 것과 설명 */
  const [subject, setSubject] = useState<{ title: string; viz: ReturnType<typeof toViz> } | null>(null);

  async function run(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      setRes(await r.json());
      setSubject(null);
      const u = new URL(location.href);
      u.searchParams.set("q", text);
      history.replaceState(null, "", u);
    } finally {
      setBusy(false);
    }
  }

  async function focusOn(kind: "movie" | "person", id: string) {
    setBusy(true);
    try {
      const d = await fetch(`/api/focus?${kind}=${encodeURIComponent(id)}`).then((r) => r.json());
      if (d.error) return;
      setRes(null);
      setSubject({ title: d.subject, viz: { nodes: d.nodes, edges: d.edges, refused: false } });
    } finally {
      setBusy(false);
    }
  }

  // 주소에 실려 온 것을 **바로 실행한다** — 넘어온 사람에게 다시 누르게 하면 흐름이 끊긴다.
  useEffect(() => {
    const { mode: m, q: incoming, movie, person } = fromUrl();
    setMode(m);
    if (incoming) { setQ(incoming); void run(incoming); }
    else if (movie) void focusOn("movie", movie);
    else if (person) void focusOn("person", person);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let dead = false;
    let api: SceneApi | null = null;
    setReady(false);
    (async () => {
      const { createScene } = await import("./scene.ts");
      if (mode === "field" && !fieldRef.current) {
        const d = await fetch("/api/graph").then((r) => r.json());
        fieldRef.current = { nodes: d.nodes };
      }
      if (dead || !hostRef.current) return;
      api = createScene(hostRef.current, mode, mode === "field" ? fieldRef.current : null);
      apiRef.current = api;
      setReady(true);
    })();
    const onResize = () => apiRef.current?.resize();
    window.addEventListener("resize", onResize);
    return () => {
      dead = true;
      window.removeEventListener("resize", onResize);
      api?.dispose();
      apiRef.current = null;
    };
  }, [mode]);

  // 모드를 바꿔도 직전 결과를 그대로 다시 그린다 — 매번 다시 물으면 비교가 안 된다.
  useEffect(() => {
    if (!ready) return;
    apiRef.current?.show(res ? toViz(res) : subject ? subject.viz : null);
  }, [res, subject, ready]);

  const pick = useCallback((m: Mode) => {
    setMode(m);
    const u = new URL(location.href);
    u.searchParams.set("mode", m);
    history.replaceState(null, "", u);
  }, []);

  const current = MODES.find((m) => m.id === mode)!;

  return (
    <div className="viz-wrap">
      <div className="viz-stage" ref={hostRef}>
        <div className="viz-switch" role="group" aria-label="시각화 방식">
          {MODES.map((m) => (
            <button key={m.id} type="button" className={m.id === mode ? "on" : undefined}
              aria-pressed={m.id === mode} onClick={() => pick(m.id)}>{m.name}</button>
          ))}
        </div>
        {(res || subject) && <p className="viz-question">{res ? res.question : subject!.title}</p>}

        {/*
          범례는 화면에 **고정**한다. 3D 공간 안에 둔 층 이름은 회전하면 등을 보이거나
          시야 밖으로 나간다 — 늘 보여야 하는 정보는 무대 위가 아니라 화면 위에 둔다.
        */}
        <div className="viz-legend" aria-label="색 범례">
          <span><i className="dot ko" /> 한국 작품{mode === "field" && <em> · 위쪽 원판</em>}</span>
          <span><i className="dot fo" /> 해외 작품{mode === "field" && <em> · 아래쪽 원판</em>}</span>
          <span><i className="dot br" /> 다리 — 선 위의 이름이 건너게 해 준 사람</span>
        </div>

        {!ready && <p className="viz-boot">3D 준비 중…</p>}
      </div>

      <aside className="viz-side">
        <p className="viz-mode-hint"><b>{current.name}</b> — {current.hint}</p>

        <form className="viz-ask" onSubmit={(e) => { e.preventDefault(); void run(q); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="질문" />
          <button disabled={busy || !q.trim()}>{busy ? "…" : "찾기"}</button>
        </form>

        <div className="viz-samples">
          {SAMPLES.map((s) => (
            <button key={s} type="button" onClick={() => { setQ(s); void run(s); }}>{s}</button>
          ))}
        </div>

        {!res && subject && (
          <div className="viz-result">
            <p className="viz-meta">{subject.title} · {subject.viz.nodes.length}편</p>
            <ol className="viz-list">
              {subject.viz.nodes.map((n) => (
                <li key={n.id} className={n.isSeed ? "seed" : undefined}>
                  <Link href={`/browse?id=${encodeURIComponent(n.id)}`}>
                    {n.korean ? "🇰🇷 " : ""}{n.label}
                  </Link>
                </li>
              ))}
            </ol>
          </div>
        )}

        {res && (
          <div className="viz-result">
            {res.refused ? (
              <div className="viz-stop">
                <b>답하지 않습니다</b>
                <p>{res.refusalReason}</p>
                <p className="sub">점화할 근거가 없으므로 화면도 비어 있습니다.</p>
              </div>
            ) : res.premiseBroken ? (
              <div className="viz-stop warn">
                <b>전제가 사실과 다릅니다</b>
                <p>{(res.premiseReason ?? "").replace(/\*\*/g, "")}</p>
                {res.premiseInstead && <p className="sub">{res.premiseInstead}</p>}
              </div>
            ) : (
              <>
                {res.characters.length > 0 && (
                  <p className="viz-meta">
                    배역 → {res.characters.map((c) => c.person).join(", ")}
                  </p>
                )}
                <p className="viz-meta">근거 {res.evidence.length}편 · 출발점 {res.seeds.length}곳</p>
                <ol className="viz-list">
                  {res.evidence.map((e) => (
                    <li key={e.id} className={e.isSeed ? "seed" : undefined}>
                      <Link href={`/browse?id=${encodeURIComponent(e.id)}`}>
                        {e.korean ? "🇰🇷 " : ""}{e.title}{e.year ? ` (${e.year})` : ""}
                      </Link>
                      {e.path.length > 0 && (
                        <em>{e.path.map((s) => `${s.fromLabel} ─${s.via}─▶ ${s.toLabel}`).join(" / ")}</em>
                      )}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        )}
        <p className="viz-hint">끌어서 회전 · 휠로 확대 · 선 위의 이름이 <b>다리</b>입니다</p>
      </aside>
    </div>
  );
}
