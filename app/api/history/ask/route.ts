/**
 * 한국사 질의 — 공통 `StateGraph` 를 태운다.
 *
 * 근거를 못 모았거나 범위 밖이면 **LLM 을 아예 호출하지 않는다.**
 * 호출하지 않으면 지어낼 기회 자체가 없다.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "@/lib/pipeline.ts";
import { HistoryGraph } from "@/lib/history/graph.ts";
import { historyDomain, pathLines } from "@/lib/domains/history.ts";
import { loadHistoryDocs } from "@/lib/history/data.ts";
import { evidenceBlock, generate, MODEL } from "@/lib/history/answer.ts";
import { KIND_LABEL, type EdgeKind } from "@/lib/history/config.ts";

export const runtime = "nodejs";

let cached: HistoryGraph | null = null;
async function graph() {
  if (!cached) {
    const p = join(process.cwd(), "data", "history", "graph.json");
    cached = new HistoryGraph(JSON.parse(await readFile(p, "utf-8")));
  }
  return cached;
}

export async function POST(req: Request) {
  let question = "", apiKey = "";
  try {
    const b = (await req.json()) as { question?: unknown; apiKey?: unknown };
    question = String(b.question ?? "").trim();
    apiKey = String(b.apiKey ?? "").trim();
  } catch {
    return Response.json({ error: "요청 형식이 올바르지 않습니다" }, { status: 400 });
  }
  if (!question) return Response.json({ error: "질문이 비어 있습니다" }, { status: 400 });

  const g = await graph();
  const docs = await loadHistoryDocs();
  const s: any = await build(historyDomain(g, { docs })).invoke({ question });

  // **배포본에서는 쓰는 사람의 키만 쓴다.** 서버 키를 폴백으로 두면 공개된 순간
  // 남의 지갑으로 모델이 돌아간다. 로컬 개발에서만 .env.local 로 떨어진다.
  const fallback = process.env.NODE_ENV === "production" ? undefined : process.env.OPENAI_API_KEY;
  const key = apiKey || fallback;

  let answer: string | null = null;
  let llm = { enabled: false, reason: "", model: MODEL };
  if (s.refused) {
    llm.reason = "근거가 없어 호출하지 않았습니다";
  } else if (!key) {
    llm.reason = "OpenAI 키가 없어 근거만 표시합니다 — 상단 ‘설정’에서 넣을 수 있습니다";
  } else {
    try {
      answer = await generate(question, evidenceBlock(s.triples, s.evidence.map((e: any) => e.path)), key);
      llm.enabled = true;
    } catch (e) {
      llm.reason = `LLM 호출 실패 — ${(e as Error).message}`;
    }
  }

  // ── 3D 용 — **실제로 탄 경로**를 그대로 노드·엣지로 넘긴다 ──────────
  //  질문 화면이 이것을 VIZ_EVENT 로 던지면 오른쪽 3D 가 답을 찾은 길을 그린다.
  const seedSet = new Set<string>(s.seedIds);
  const viz = {
    nodes: s.evidence.slice(0, 24).map((e: any) => ({
      id: e.id, label: e.id, hop: e.path.length, isSeed: seedSet.has(e.id),
      korean: e.type === "Person",
      // 근거 카드의 "씨앗에서 여기까지" 줄
      path: e.path.length
        ? e.path.reduce((acc: string, h: any) =>
            `${acc} ─${KIND_LABEL[h.kind as EdgeKind] ?? h.kind}${h.dir === "out" ? "─▶" : "◀─"} ${h.to}`,
            e.path[0].from)
        : undefined,
    })),
    edges: s.evidence.slice(0, 24).flatMap((e: any) =>
      e.path.map((h: any) => ({ from: h.from, to: h.to, via: KIND_LABEL[h.kind as EdgeKind] ?? h.kind }))),
  };

  return Response.json({
    question, answer, llm, viz,
    routeKind: s.routeKind, reason: s.reason,
    refused: s.refused, refusalReason: s.refusalReason,
    trace: s.trace,
    seeds: s.seedIds,
    paths: pathLines(s, 12),
    triples: s.triples.slice(0, 40).map((t: any) => ({
      from: t.from, kind: t.kind, to: t.to, quote: t.quotes[0] ?? null, doc: t.docs[0] ?? null,
    })),
    sources: s.sources,
    counts: { evidence: s.evidence.length, triples: s.triples.length, dropped: s.dropped, blocked: s.blocked },
  });
}
