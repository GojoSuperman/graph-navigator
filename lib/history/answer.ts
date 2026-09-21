/**
 * 답변 문장 생성 — **LLM 이 있는 유일한 자리.**
 *
 * 근거에 있는 것만 말한다. 없으면 "확인되지 않습니다". 모델이 아는 역사 지식으로
 * 채우면 이 도구의 값어치가 통째로 사라진다 — 근거를 모아 온 이유가 없어진다.
 */

import { KIND_LABEL, type EdgeKind } from "./config.ts";

const BASE = "https://api.openai.com/v1";
export const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const SYSTEM = `너는 한국사 지식 그래프의 **근거만 읽고** 답하는 답변기다.

## 규칙
1. **근거에 있는 것만 말한다.** 네가 아는 역사 지식으로 채우지 마라.
2. 근거로 답할 수 없으면 정확히 이렇게 답한다: "근거에서 확인되지 않습니다."
3. 두세 문장 안에 답한다. 답을 먼저 말하고, 근거가 무엇인지 덧붙인다.
4. 근거의 삼중항 (A)─관계─▶(B) 는 "A가 B에 대해 그 관계에 있다" 는 뜻이다.
4-1. **「탄 경로」가 있으면 그것부터 읽어라.** 질문이 "A가 한 X 의 Y 는?" 처럼 여러
   단계를 요구할 때, 그 경로 줄이 A 에서 답까지 어떻게 갔는지를 그대로 보여 준다.
5. 추측·가능성·일반론을 쓰지 마라. 근거가 말하지 않은 인과를 지어내지 마라.`;

type Triple = { from: string; kind: string; to: string; quotes: string[]; docs: string[] };
type Hop = { from: string; to: string; kind: string; dir: string };

const label = (k: string) => KIND_LABEL[k as EdgeKind] ?? k;

/**
 * 모델에게 주는 근거.
 *
 * **처음엔 삼중항만 줬다. 그것이 답변 층 고장의 원인이었다.**
 * 파이프라인이 탄 경로를 기록하는데 프롬프트에 안 넣고 있었다 — 모델은 삼중항
 * 150개를 평평한 목록으로 받아 **멀티홉 연결을 스스로 재구성**해야 했다.
 * 1홉 80% / 3홉 14% 가 그렇게 갈렸다. 경로를 기록하는 이유가 제시하기 위해서인데
 * 정작 답변을 만드는 쪽에 안 준 것이다.
 *
 * 이제 **씨앗에서 실제로 탄 경로를 먼저** 보여 주고, 삼중항은 그 뒤에 붙인다.
 */
/**
 * `limit` 기본값이 **30이었고 그것이 답변 층 고장의 진짜 원인이었다.**
 *
 * 실측: "1948년 김규식이 참여한 협상에 함께 참여한 인물은?" 에서 답이 든 삼중항
 * `(김구)─참여─▶(남북협상)` 은 **90번째**였다. 모델은 앞 30개만 받았으니
 * **답을 본 적이 없다.** 그래 놓고 "근거에서 확인되지 않습니다" 라고 답한 것이다.
 *
 * `maxNodes` 스윕이 평평했던 이유도 이것이다 — 40이든 80이든 30에서 잘렸다.
 * 근거를 더 모아도 모델에게 안 갔다.
 */
export function evidenceBlock(triples: Triple[], paths: Hop[][] = [], limit = 200): string {
  const out: string[] = [];
  const lines = paths.filter((p) => p.length).map((p) => {
    let s = p[0].from;
    for (const h of p) s += ` ─${label(h.kind)}${h.dir === "out" ? "─▶" : "◀─"} ${h.to}`;
    return s;
  });
  if (lines.length) {
    out.push("「씨앗에서 실제로 탄 경로」 — 질문이 여러 단계를 요구하면 이 줄을 따라가라");
    out.push(...[...new Set(lines)].slice(0, 20).map((l) => `  ${l}`), "");
  }
  out.push("「삼중항과 근거」");
  out.push(...triples.slice(0, limit).map((t) =>
    `(${t.from}) ─${label(t.kind)}─▶ (${t.to})\n` +
    (t.quotes[0] ? `    근거: "${t.quotes[0]}"\n` : "") +
    (t.docs[0] ? `    출처: 위키백과 《${t.docs[0]}》` : "")
  ));
  return out.join("\n");
}

export async function generate(question: string, evidence: string, key?: string): Promise<string | null> {
  const apiKey = key ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  if (!evidence.trim()) return null;
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL, temperature: 0.2, max_tokens: 400,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `질문: ${question}\n\n「근거」\n${evidence}` },
      ],
    }),
  });
  if (!res.ok) {
    const t = (await res.text()).slice(0, 80).replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
    throw new Error(`HTTP ${res.status} — ${t}`);
  }
  const j: any = await res.json();
  return j.choices?.[0]?.message?.content?.trim() ?? null;
}
