"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { SceneApi, VizEdge, VizNode } from "@/lib/scene.ts";

/**
 * 오른쪽에 붙박이로 사는 3D 패널.
 *
 * 3D 를 별도 페이지로 두었더니 **보러 가면 원래 보던 것을 떠나야 했다.**
 * 그래서 화면을 세로로 나누고 오른쪽에 상주시킨다.
 * 왼쪽에서 무엇을 보고 있든 오른쪽이 따라 바뀐다.
 *
 * 주제를 받는 방법이 둘이다 —
 *   ① 주소 (작품 탐색기·지도의 이동은 실제 네비게이션이다)
 *   ② 이벤트 (질문 화면의 답은 클라이언트 상태라 주소가 안 바뀐다)
 */
type Subject = { title: string; nodes: VizNode[]; edges: VizEdge[] } | null;

/** TMDB 포스터 주소 */
const posterUrl = (p: string) => `https://image.tmdb.org/t/p/w500${p}`;

export const VIZ_EVENT = "viz:subject";

export default function VizDock() {
  const pathname = usePathname();
  const params = useSearchParams();
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<SceneApi | null>(null);
  const [subject, setSubject] = useState<Subject>(null);
  const [busy, setBusy] = useState(false);
  /** 3D 에서 고른 작품 — 포스터 모달 */
  const [picked, setPicked] = useState<VizNode | null>(null);
  const [mode, setMode] = useState<"focus" | "field">("focus");
  /** 전경형 배경은 한 번만 받아 둔다 — 토글할 때마다 다시 받지 않도록 */
  const fieldRef = useRef<{ nodes: { id: string; title: string; korean: boolean }[] } | null>(null);

  // ── 씬 ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let dead = false;
    let api: SceneApi | null = null;
    (async () => {
      const { createScene } = await import("@/lib/scene.ts");
      if (mode === "field" && !fieldRef.current) {
        const d = await fetch("/api/graph").then((r) => r.json());
        fieldRef.current = { nodes: d.nodes };
      }
      if (dead || !hostRef.current) return;
      api = createScene(
        hostRef.current, mode, mode === "field" ? fieldRef.current : null,
        (n) => setPicked(n),
      );
      apiRef.current = api;
      api.show(subject ? { ...subject, refused: false } : null);
    })();
    const onResize = () => apiRef.current?.resize();
    window.addEventListener("resize", onResize);
    return () => {
      dead = true;
      window.removeEventListener("resize", onResize);
      api?.dispose();
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    apiRef.current?.show(subject ? { ...subject, refused: false } : null);
  }, [subject]);

  // ── ① 주소에서 주제 읽기 ───────────────────────────────────────────
  useEffect(() => {
    const id = params.get("id");
    const person = params.get("person");
    const kind = person ? "person" : id ? "movie" : null;
    const value = person || id;
    if (!kind || !value) {
      if (pathname === "/map" || pathname === "/") return;   // 질문 화면은 이벤트로 받는다
      setSubject(null);
      return;
    }
    let dead = false;
    setBusy(true);
    fetch(`/api/focus?${kind}=${encodeURIComponent(value)}`)
      .then((r) => r.json())
      .then((d) => { if (!dead && !d.error) setSubject({ title: d.subject, nodes: d.nodes, edges: d.edges }); })
      .finally(() => { if (!dead) setBusy(false); });
    return () => { dead = true; };
  }, [pathname, params]);

  // ── ② 질문 화면이 보내는 이벤트 ────────────────────────────────────
  useEffect(() => {
    const on = (e: Event) => setSubject((e as CustomEvent<Subject>).detail);
    window.addEventListener(VIZ_EVENT, on);
    return () => window.removeEventListener(VIZ_EVENT, on);
  }, []);

  return (
    <aside className="dock">
      <div className="dock-bar">
        <div className="dock-switch" role="group" aria-label="시각화 방식">
          {(["focus", "field"] as const).map((m) => (
            <button key={m} type="button" className={m === mode ? "on" : undefined}
              aria-pressed={m === mode} onClick={() => setMode(m)}>
              {m === "focus" ? "집중형" : "전경형"}
            </button>
          ))}
        </div>

        <span className="dock-title">{busy ? "그리는 중…" : subject?.title ?? "3D"}</span>

        {/* 범례는 막대 오른쪽 끝. 한 줄로 짧게 둬야 줄바꿈되지 않는다. */}
        <div className="dock-legend" aria-label="색 범례">
          <span><i className="dot ko" /> 한국</span>
          <span><i className="dot fo" /> 해외</span>
          <span><i className="dot br" /> 다리</span>
        </div>
      </div>
      <div className="dock-stage" ref={hostRef}>
        {/* 마우스 사용법 — 3D 는 눌러 보기 전엔 뭘 할 수 있는지 알 수 없다 */}
        <div className="dock-help" aria-label="마우스 사용법">
          <strong>마우스 사용법</strong>
          <span><b>왼쪽 클릭</b> 회전</span>
          <span><b>휠</b> 확대·축소</span>
          <span><b>오른쪽 클릭</b> 이동</span>
        </div>

        {picked && (
          <div className="poster-back" onClick={(e) => e.target === e.currentTarget && setPicked(null)}>
            <div className="poster" role="dialog" aria-modal="true" aria-label={picked.label}>
              <button className="poster-x" onClick={() => setPicked(null)} aria-label="닫기">✕</button>
              {picked.poster
                ? <img src={posterUrl(picked.poster)} alt={`${picked.label} 포스터`} />
                : <div className="poster-none">포스터 없음</div>}
              <div className="poster-info">
                <b>{picked.label}</b>
                <span>{picked.year ?? ""} {picked.korean ? "· 🇰🇷 한국" : "· 해외"}</span>
                <Link href={`/browse?id=${encodeURIComponent(picked.id)}`} onClick={() => setPicked(null)}>
                  자세히 보기 →
                </Link>
              </div>
            </div>
          </div>
        )}

        {!subject && !busy && (
          <p className="dock-empty">
            <span>
              왼쪽에서 작품·인물을 고르거나 질문하면
              <br />여기에 <b>건너간 다리</b>가 그려집니다
            </span>
          </p>
        )}
      </div>
    </aside>
  );
}
