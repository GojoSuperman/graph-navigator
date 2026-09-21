/**
 * 질의 파이프라인 — **두 도메인이 한 그래프를 쓴다** (설계서 §6).
 *
 * 그래프 모양·노드 이름·엣지 조건은 여기서 한 번만 정하고, 각 노드가 무슨 일을
 * 하는지는 도메인이 주입한다. 과제 REPORT 4번이 요구하는 "LangGraph 노드 및
 * 상태(State) 흐름" 다이어그램은 **이 파일을 그대로 옮기면 된다.**
 *
 *                START
 *                  │
 *              followup ──(이어지는 질문)──┐
 *                  │                      │
 *                route ──(범위 밖)────────┤
 *                  │                      │
 *                seeds ──(씨앗 없음)──────┤
 *                  │                      │
 *               expand ──(근거 부족)──────┤
 *                  │                      │
 *              assemble                 refuse
 *                  │                      │
 *               answer ───────┬───────────┘
 *                          record
 *                            │
 *                           END
 */

import { StateGraph, StateSchema, START, END, type InferStateSchemaValue } from "@langchain/langgraph";

// **State 키가 노드 이름과 같으면 LangGraph 가 거부한다.**
// 그래서 `route`·`seeds`·`answer` 는 State 쪽을 `routeKind`·`seedIds`·`answerText`
// 로 바꿨다 — REPORT 다이어그램에 나가는 것은 노드 이름이므로 그쪽을 지켰다.
import { z } from "zod";

/** 근거 한 덩어리 — 노드 하나와 거기까지 **실제로 탄 경로** */
export interface EvidenceItem {
  id: string;
  type: string;
  era: string | null;
  /** 이 노드까지 어떻게 왔는가. 씨앗이면 빈 배열 */
  path: { from: string; to: string; kind: string; dir: string }[];
  isSeed: boolean;
}

export interface Triple { from: string; kind: string; to: string; quotes: string[]; docs: string[] }

const askFields = {
  question: z.string(),
  /** 이어지는 질문일 때 직전 근거 */
  previous: z.array(z.string()).default([]),
  followUp: z.boolean().default(false),

  routeKind: z.string().default(""),
  reason: z.string().default(""),
  seedIds: z.array(z.string()).default([]),

  /** **실제로 탄 경로** — 루브릭 2가 "기록해 답변과 함께 제시하는가" 를 묻는 곳 */
  path: z.array(z.custom<EvidenceItem["path"][number]>()).default([]),
  evidence: z.array(z.custom<EvidenceItem>()).default([]),
  triples: z.array(z.custom<Triple>()).default([]),
  sources: z.array(z.string()).default([]),
  dropped: z.number().default(0),
  blocked: z.number().default(0),

  answerText: z.string().nullable().default(null),
  refused: z.boolean().default(false),
  refusalReason: z.string().nullable().default(null),
  /** 지나온 노드 이름 — runs.jsonl 에 남는다. 실패가 어느 층에서 났는지 여기서 보인다 */
  trace: z.array(z.string()).default([]),
};

export const AskState = new StateSchema(askFields);

/** State 의 실제 타입 — 노드 함수가 받는 것 */
export type Ask = InferStateSchemaValue<typeof askFields>;

/**
 * 도메인이 채워 넣는 것. **그래프 모양은 건드리지 못한다.**
 * 채우는 칸은 같고 채우는 방법이 다르다 — 그것이 "같은 엔진, 다른 도메인" 의 뜻이다.
 */
export interface Domain {
  name: string;
  /** 없으면 followup 노드는 그냥 통과한다 (인물 도메인은 아직 안 받는다) */
  followUp?: (s: Ask) => Partial<Ask>;
  route: (s: Ask) => Partial<Ask>;
  seeds: (s: Ask) => Partial<Ask>;
  expand: (s: Ask) => Partial<Ask>;
  assemble: (s: Ask) => Partial<Ask>;
  answer: (s: Ask) => Promise<Partial<Ask>>;
  /** 질의 기록. 없으면 아무것도 안 한다 */
  record?: (name: string, s: Ask) => void;
}

/** 노드를 감싸 `trace` 에 이름을 남긴다 — 어디서 끊겼는지가 기록으로 남아야 한다 */
const traced = (name: string, fn: (s: any) => any) => (s: any) => {
  const out = fn(s) ?? {};
  return out instanceof Promise
    ? out.then((o: any) => ({ ...(o ?? {}), trace: [...(s.trace ?? []), name] }))
    : { ...out, trace: [...(s.trace ?? []), name] };
};

export function build(d: Domain) {
  return new StateGraph(AskState)
    .addNode("followup", traced("followup", d.followUp ?? (() => ({}))))
    .addNode("route", traced("route", d.route))
    .addNode("seeds", traced("seeds", d.seeds))
    .addNode("expand", traced("expand", d.expand))
    .addNode("assemble", traced("assemble", d.assemble))
    .addNode("answer", traced("answer", d.answer))
    .addNode("refuse", traced("refuse", (s: any) => ({
      refused: true,
      refusalReason: s.refusalReason ?? "근거를 찾지 못했습니다",
    })))
    .addNode("record", (s: any) => { d.record?.(d.name, s); return {}; })
    .addEdge(START, "followup")
    .addConditionalEdges("followup", (s: any) => (s.followUp ? "record" : "route"), ["record", "route"])
    .addConditionalEdges("route", (s: any) => (s.routeKind === "out_of_scope" ? "refuse" : "seeds"), ["refuse", "seeds"])
    .addConditionalEdges("seeds", (s: any) => (s.seedIds.length ? "expand" : "refuse"), ["expand", "refuse"])
    .addConditionalEdges("expand", (s: any) => (s.evidence.length ? "assemble" : "refuse"), ["assemble", "refuse"])
    .addEdge("assemble", "answer")
    .addEdge("answer", "record")
    .addEdge("refuse", "record")
    .addEdge("record", END)
    .compile();
}
