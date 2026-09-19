"use client";

import { useEffect, useState } from "react";

/**
 * OpenAI 키 설정.
 *
 * ── 왜 브라우저에 두나 ──────────────────────────────────────────────
 * 배포하면 답변 생성 비용을 누가 낼 것인가가 문제가 된다.
 * 서버 키 하나로 받으면 공개된 순간 남의 지갑으로 모델을 돌리게 된다.
 * 그래서 **쓰는 사람이 자기 키를 가져오는** 방식으로 둔다.
 *
 * 키는 localStorage 에만 두고 요청마다 실어 보낸다. 서버에 저장하지 않는다.
 * 다만 요청이 우리 서버를 거치므로 **서버는 키를 보게 된다** — 그 사실을 화면에 적는다.
 * 숨기고 "안전합니다" 라고 하는 것보다 낫다.
 *
 * 키가 없으면 근거까지만 보여 준다. 그것만으로도 이 도구는 동작한다 —
 * LLM 은 마지막 문장만 쓰기 때문이다.
 */
export const KEY_STORE = "movie-navigator:openai-key";

/** 저장된 키 읽기 — 없거나 접근이 막혀 있으면 빈 문자열 */
export function storedKey(): string {
  try {
    return localStorage.getItem(KEY_STORE) ?? "";
  } catch {
    return "";
  }
}

const mask = (k: string) => (k.length <= 12 ? "•".repeat(k.length) : `${k.slice(0, 6)}…${k.slice(-4)}`);

export default function Settings() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => setSaved(storedKey()), []);
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open]);

  function save() {
    const v = value.trim();
    if (!v) return;
    try {
      localStorage.setItem(KEY_STORE, v);
      setSaved(v);
      setValue("");
      setMsg("저장했습니다. 이제 답변 문장이 생성됩니다.");
    } catch {
      setMsg("브라우저가 저장을 막고 있습니다 (시크릿 창이면 창을 닫을 때까지만 유지됩니다)");
    }
  }

  function clear() {
    try { localStorage.removeItem(KEY_STORE); } catch { /* 지우지 못해도 화면은 갱신한다 */ }
    setSaved("");
    setMsg("지웠습니다. 이제 근거까지만 보여 줍니다.");
  }

  return (
    <>
      <button className="nav-settings" onClick={() => { setOpen(true); setMsg(""); }}>
        설정{saved && <i className="on" aria-label="키 설정됨" />}
      </button>

      {open && (
        <div className="modal-back" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="설정">
            <div className="modal-head">
              <h2>OpenAI 키</h2>
              <button onClick={() => setOpen(false)} aria-label="닫기">✕</button>
            </div>

            <p className="modal-lead">
              답변 문장을 만들 때만 씁니다. <b>키가 없어도 이 도구는 동작합니다</b> —
              근거(작품·인물·경로)는 그래프에서 나오고, 모델은 마지막 문장만 씁니다.
            </p>

            <label className="modal-label" htmlFor="oai">키 입력</label>
            <div className="modal-row">
              <input
                id="oai"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-…"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && save()}
              />
              <button className="primary" onClick={save} disabled={!value.trim()}>저장</button>
            </div>

            <p className="modal-state">
              {saved
                ? <>현재 저장됨 · <code>{mask(saved)}</code> <button className="link" onClick={clear}>지우기</button></>
                : <>저장된 키가 없습니다 — 지금은 <b>근거까지만</b> 보여 줍니다</>}
            </p>
            {msg && <p className="modal-msg">{msg}</p>}

            <div className="modal-note">
              <p><b>키는 이 브라우저에만 저장됩니다.</b> 서버에 보관하지 않습니다.</p>
              <p>
                다만 답변을 만들 때 요청이 이 사이트 서버를 거치므로,
                <b> 서버는 요청을 처리하는 동안 키를 보게 됩니다.</b> 남의 서버에 키를 맡기는 것이
                꺼려지면 키를 넣지 않고 근거만 보셔도 됩니다.
              </p>
              <p>
                키는 <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
                platform.openai.com/api-keys</a> 에서 발급합니다.
                사용량 한도를 낮게 걸어 두시길 권합니다.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
