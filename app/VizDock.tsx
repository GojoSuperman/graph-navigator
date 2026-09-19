"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { SceneApi, VizEdge, VizNode } from "./viz/scene.ts";

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

export const VIZ_EVENT = "viz:subject";

export default function VizDock() {
  const pathname = usePathname();
  const params = useSearchParams();
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<SceneApi | null>(null);
  const [open, setOpen] = useState(true);
  const [subject, setSubject] = useState<Subject>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"focus" | "field">("focus");
  /** 전경형 배경은 한 번만 받아 둔다 — 토글할 때마다 다시 받지 않도록 */
  const fieldRef = useRef<{ nodes: { id: string; title: string; korean: boolean }[] } | null>(null);

  // /viz 는 전체 화면 3D 다 — 거기서는 패널을 띄우지 않는다 (캔버스 두 개가 되지 않게)
  const hidden = pathname?.startsWith("/viz");

  // ── 씬 ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (hidden || !open) return;
    let dead = false;
    let api: SceneApi | null = null;
    (async () => {
      const { createScene } = await import("./viz/scene.ts");
      if (mode === "field" && !fieldRef.current) {
        const d = await fetch("/api/graph").then((r) => r.json());
        fieldRef.current = { nodes: d.nodes };
      }
      if (dead || !hostRef.current) return;
      api = createScene(hostRef.current, mode, mode === "field" ? fieldRef.current : null);
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
  }, [hidden, open, mode]);

  useEffect(() => {
    apiRef.current?.show(subject ? { ...subject, refused: false } : null);
  }, [subject]);

  // ── ① 주소에서 주제 읽기 ───────────────────────────────────────────
  useEffect(() => {
    if (hidden) return;
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
  }, [pathname, params, hidden]);

  // ── ② 질문 화면이 보내는 이벤트 ────────────────────────────────────
  useEffect(() => {
    const on = (e: Event) => setSubject((e as CustomEvent<Subject>).detail);
    window.addEventListener(VIZ_EVENT, on);
    return () => window.removeEventListener(VIZ_EVENT, on);
  }, []);

  if (hidden) return null;

  return (
    <aside className={open ? "dock" : "dock closed"}>
      <div className="dock-bar">
        <button className="dock-fold" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "▸" : "◂ 3D"}
        </button>

        {open && (
          <>
            <div className="dock-switch" role="group" aria-label="시각화 방식">
              {(["focus", "field"] as const).map((m) => (
                <button key={m} type="button" className={m === mode ? "on" : undefined}
                  aria-pressed={m === mode} onClick={() => setMode(m)}>
                  {m === "focus" ? "집중형" : "전경형"}
                </button>
              ))}
            </div>

            <span className="dock-title">{busy ? "그리는 중…" : subject?.title ?? "3D"}</span>

            {/* 범례는 무대 위가 아니라 막대에 둔다 — 회전해도 늘 보여야 한다 */}
            <div className="dock-legend" aria-label="색 범례">
              <span><i className="dot ko" /> 한국 작품</span>
              <span><i className="dot fo" /> 해외 작품</span>
              <span><i className="dot br" /> 다리 — 선 위의 이름이 건너게 해 준 사람</span>
            </div>
          </>
        )}
      </div>
      {open && (
        <div className="dock-stage" ref={hostRef}>
          {!subject && !busy && (
            <p className="dock-empty">
              왼쪽에서 작품·인물을 고르거나 질문하면
              <br />여기에 <b>건너간 다리</b>가 그려집니다
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
