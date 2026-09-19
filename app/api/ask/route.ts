/**
 * 질문 → 탐색 → 근거 → (LLM 답변 1회)
 *
 * 근거를 못 모았거나 범위 밖이면 **LLM 을 아예 호출하지 않는다.**
 * 호출하지 않으면 지어낼 기회 자체가 없다 — law-navigator 에서 가져온 원칙이다.
 */
import { loadGraph } from "@/lib/data.ts";
import { ask } from "@/lib/ask.ts";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let question = "";
  try {
    question = String(((await req.json()) as { question?: unknown }).question ?? "").trim();
  } catch {
    return Response.json({ error: "요청 형식이 올바르지 않습니다" }, { status: 400 });
  }
  if (!question) return Response.json({ error: "질문이 비어 있습니다" }, { status: 400 });

  const g = await loadGraph();
  const result = ask(g, question);

  // 왜 답변 문장이 없는지 숨기지 않는다 — 비어 있는 것과 고장난 것을 구분할 수 있어야 한다.
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const llm = result.refused
    ? { enabled: false as const, reason: "근거가 없어 호출하지 않았습니다" }
    : result.premiseBroken
      ? { enabled: false as const, reason: "질문의 전제가 사실이 아니라 호출하지 않았습니다" }
      : hasKey
        ? { enabled: false as const, reason: "답변 생성은 아직 연결되지 않았습니다" }
        : { enabled: false as const, reason: "ANTHROPIC_API_KEY 가 없어 근거만 표시합니다" };

  return Response.json({ ...result, answer: null, llm });
}
