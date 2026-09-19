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

  /**
   * 별칭을 먼저 알려 준다. TMDB 는 인물을 활동명으로 저장하므로,
   * "돈 리가 나온 영화" 를 물었는데 근거에는 **마동석**으로 적혀 있다.
   * 이 줄이 없으면 모델이 동일인임을 모르고 "확인되지 않습니다" 라고 답한다.
   */
  const withAlias = r.matchedPeople.filter((p) => p.aliases.length);
  if (withAlias.length) {
    lines.push("[같은 사람의 다른 이름]");
    for (const p of withAlias) lines.push(`- ${p.name} = ${p.aliases.join(" = ")}`);
  }

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

/**
 * @param userKey 쓰는 사람이 가져온 키. 배포본에서는 이것만 쓴다.
 *   서버 키(OPENAI_API_KEY)는 로컬 개발용 폴백이다 —
 *   공개된 서버가 제 키로 모델을 돌리면 남의 지갑이 열린다.
 */
export async function generateAnswer(r: AskResult, userKey?: string): Promise<AnswerResult> {
  // ── 코드 층 ────────────────────────────────────────────────────────
  if (r.refused) return { text: null, reason: "근거가 없어 호출하지 않았습니다" };
  if (r.premiseBroken) return { text: null, reason: "질문의 전제가 사실이 아니라 호출하지 않았습니다" };
  /**
   * 배포본에서는 **쓰는 사람의 키만** 쓴다.
   * 서버 키를 폴백으로 두면 공개된 순간 남의 지갑으로 모델이 돌아간다.
   * 로컬 개발에서만 .env.local 의 키로 떨어진다.
   */
  const fallback = process.env.NODE_ENV === "production" ? undefined : process.env.OPENAI_API_KEY;
  const key = (userKey ?? "").trim() || fallback;
  if (!key) {
    return { text: null, reason: "OpenAI 키가 없어 근거만 표시합니다 — 상단 ‘설정’에서 넣을 수 있습니다" };
  }

  const evidence = evidenceBlock(r);
  if (!evidence.trim()) return { text: null, reason: "모아 온 근거가 비어 있습니다" };

  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 500,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: r.followUp
              // 이어지는 질문은 **직전 질문이 무엇이었는지** 알아야 답이 자연스럽다
              ? `앞선 질문: ${r.followUp.of}\n이어지는 질문: ${r.question}\n(직전 결과에서 ${r.followUp.filters.join(" · ")} 로 추렸다)\n\n「근거」\n${evidence}`
              : `질문: ${r.question}\n\n「근거」\n${evidence}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      // 오류 본문에 키가 섞여 나올 수 있다. 상태 코드와 사유만 전한다.
      const why = res.status === 401 ? "키가 올바르지 않습니다"
        : res.status === 429 ? "사용량 한도에 걸렸습니다"
        : body.slice(0, 80).replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
      return { text: null, reason: `LLM 호출 실패 (HTTP ${res.status}) — ${why}` };
    }
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) return { text: null, reason: "빈 응답이 왔습니다" };
    return { text, reason: "", model: j.model };
  } catch (e) {
    return { text: null, reason: `LLM 호출 오류 — ${(e as Error).message}` };
  }
}
