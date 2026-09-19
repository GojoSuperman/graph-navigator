/**
 * 답변 문장 생성 — 이 파일이 **유일하게 LLM 을 호출하는 곳**이다.
 *
 * 탐색(graph.ts)·라우팅(route.ts)·조립(ask.ts)에는 LLM 이 한 줄도 없다.
 * 무엇을 근거로 데려왔는지를 모델 없이 검증할 수 있어야 하기 때문이고,
 * 그래서 평가(evaluate.ts)가 비용 0 으로 돌아간다.
 *
 * ── 2겹 차단 (law-navigator 에서 그대로) ────────────────────────────
 *   코드 층   근거가 없거나 전제가 틀렸으면 **호출 자체를 하지 않는다.**
 *             호출하지 않으면 지어낼 기회가 없다.
 *   프롬프트 층 "아래 근거에만 있는 사실을 쓰라. 없으면 없다고 하라."
 */

import type { AskResult } from "./ask.ts";

const BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

export interface AnswerResult {
  text: string | null;
  /** 왜 없는지 — 비어 있는 것과 고장난 것을 사용자가 구분할 수 있어야 한다 */
  reason: string;
  model?: string;
}

const SYSTEM = `너는 영화 정보를 **주어진 근거만으로** 답하는 도우미다.

규칙
1. 아래 「근거」에 적힌 사실만 쓴다. 근거에 없으면 "확인되지 않습니다" 라고 말한다.
   네가 따로 아는 영화 지식을 끌어오지 마라. 근거가 전부다.
2. 작품명은 《》로, 사람 이름은 그대로 쓴다.
3. 두세 문장으로 짧게. 목록이 자연스러우면 목록으로.
4. 근거가 질문과 어긋나면 그렇다고 말한다. 억지로 답을 만들지 마라.
5. 한국어로 답한다.`;

/** 모델에게 보여 줄 근거 — 화면에 뜨는 것과 같은 내용이어야 한다 */
function evidenceBlock(r: AskResult): string {
  const lines: string[] = [];

  if (r.cast.length) {
    lines.push("[출연·제작진]");
    for (const c of r.cast) lines.push(`- ${c.name} (${c.role}${c.as ? `, ${c.as} 역` : ""})`);
  }
  if (r.characters.length) {
    lines.push("[배역으로 찾은 사람]");
    for (const c of r.characters) lines.push(`- ${c.person} — 《${c.movie}》 ${c.as} 역`);
  }
  if (r.commonMovies.length) {
    lines.push("[두 사람이 함께 나온 작품]");
    for (const m of r.commonMovies) lines.push(`- 《${m.title}》${m.year ? ` (${m.year})` : ""}`);
  }
  if (r.commonPeople.length) {
    lines.push("[여러 작품에 모두 참여한 사람]");
    for (const p of r.commonPeople) lines.push(`- ${p.name}${p.acted ? "" : " (출연 아님, 제작진)"}`);
  }
  if (r.personAwards.length) {
    lines.push("[수상]");
    for (const a of r.personAwards) {
      lines.push(`- ${a.person}: ${a.award}${a.year ? ` (${a.year})` : ""}${a.forTitle ? ` — 《${a.forTitle}》` : ""}`);
    }
  }
  if (r.evidence.length) {
    lines.push("[작품]");
    for (const e of r.evidence) {
      const path = e.path.length ? `  ← ${e.path.map((s) => `${s.fromLabel}에서 ${s.via}를 거쳐`).join(", ")}` : "";
      const aw = e.awards.length ? ` · 수상: ${e.awards.slice(0, 3).map((a) => a.award).join(", ")}` : "";
      lines.push(`- 《${e.title}》${e.year ? ` (${e.year})` : ""} · ${e.genres.join("/")} · 평점 ${e.voteAverage.toFixed(1)}${aw}${path}`);
      if (e.overview) lines.push(`    줄거리: ${e.overview.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  return lines.join("\n");
}

export async function generateAnswer(r: AskResult): Promise<AnswerResult> {
  // ── 코드 층 ────────────────────────────────────────────────────────
  if (r.refused) return { text: null, reason: "근거가 없어 호출하지 않았습니다" };
  if (r.premiseBroken) return { text: null, reason: "질문의 전제가 사실이 아니라 호출하지 않았습니다" };
  if (!process.env.OPENAI_API_KEY) return { text: null, reason: "OPENAI_API_KEY 가 없어 근거만 표시합니다" };

  const evidence = evidenceBlock(r);
  if (!evidence.trim()) return { text: null, reason: "모아 온 근거가 비어 있습니다" };

  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 500,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `질문: ${r.question}\n\n「근거」\n${evidence}` },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { text: null, reason: `LLM 호출 실패 (HTTP ${res.status}) — ${body.slice(0, 120)}` };
    }
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) return { text: null, reason: "빈 응답이 왔습니다" };
    return { text, reason: "", model: j.model };
  } catch (e) {
    return { text: null, reason: `LLM 호출 오류 — ${(e as Error).message}` };
  }
}
