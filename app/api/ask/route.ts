/**
 * 질문 → 탐색 → 근거 → (LLM 답변 1회)
 *
 * 근거를 못 모았거나 범위 밖이면 **LLM 을 아예 호출하지 않는다.**
 * 호출하지 않으면 지어낼 기회 자체가 없다 — law-navigator 에서 가져온 원칙이다.
 */
import { loadGraph } from "@/lib/data.ts";
import { ask } from "@/lib/ask.ts";
import { generateAnswer } from "@/lib/answer.ts";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let question = "";
  let previous: { question: string; movieIds: string[] } | undefined;
  try {
    const body = (await req.json()) as { question?: unknown; previous?: unknown };
    question = String(body.question ?? "").trim();
    const pv = body.previous as { question?: string; movieIds?: string[] } | undefined;
    if (pv?.question && Array.isArray(pv.movieIds) && pv.movieIds.length) {
      previous = { question: String(pv.question), movieIds: pv.movieIds.map(String).slice(0, 30) };
    }
  } catch {
    return Response.json({ error: "요청 형식이 올바르지 않습니다" }, { status: 400 });
  }
  if (!question) return Response.json({ error: "질문이 비어 있습니다" }, { status: 400 });

  const g = await loadGraph();
  const result = ask(g, question, previous);

  // 왜 답변 문장이 없는지 숨기지 않는다 — 비어 있는 것과 고장난 것을 구분할 수 있어야 한다.
  const a = await generateAnswer(result);

  return Response.json({
    ...result,
    answer: a.text,
    llm: { enabled: Boolean(a.text), reason: a.reason, model: a.model },
  });
}
