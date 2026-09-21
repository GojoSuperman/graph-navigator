/**
 * 한국사 지식 그래프 — 적재와 n홉 탐색.
 *
 * **LLM 호출이 없다.** 무엇을 근거로 데려왔는지를 모델 없이(비용 0, 결정적으로)
 * 검증할 수 있어야 평가가 하루에 몇 번이고 돌아간다.
 */

import { BUDGET, KIND_LABEL, type EdgeKind, type Era, type NodeType } from "./config.ts";

export interface GraphNode { id: string; type: NodeType; era: Era | null; aliases: string[]; degree: number }
export interface GraphEdge { from: string; to: string; kind: EdgeKind; quotes: string[]; docs: string[] }

/** 한 홉 — 어디서 어디로 무슨 관계를 타고 갔는가. **경로 기록의 단위다.** */
export interface Hop { from: string; to: string; kind: EdgeKind; dir: "out" | "in" }

export interface Collected {
  /** 근거로 데려온 노드 (씨앗 포함, 도달 순서) */
  nodes: string[];
  /** 노드마다 **실제로 탄 경로**. 씨앗은 빈 배열 */
  paths: Map<string, Hop[]>;
  /** 예산에 걸려 버린 수 — 숨기지 않고 센다 */
  dropped: number;
  /** 허브라서 경유를 막은 수 */
  blocked: number;
}

export class HistoryGraph {
  readonly nodes = new Map<string, GraphNode>();
  readonly outs = new Map<string, GraphEdge[]>();
  readonly ins = new Map<string, GraphEdge[]>();
  readonly edges: GraphEdge[];
  /** 통과 금지 허브 — 차수 상위 n개 */
  readonly hubs: Set<string>;

  constructor(data: { nodes: GraphNode[]; edges: GraphEdge[] }, hubTop: number = BUDGET.hubTop) {
    for (const n of data.nodes) { this.nodes.set(n.id, n); this.outs.set(n.id, []); this.ins.set(n.id, []); }
    this.edges = data.edges;
    for (const e of data.edges) {
      this.outs.get(e.from)?.push(e);
      this.ins.get(e.to)?.push(e);
    }
    this.hubs = new Set([...data.nodes].sort((a, b) => b.degree - a.degree).slice(0, hubTop).map((n) => n.id));
  }

  node(id: string) { return this.nodes.get(id); }

  /**
   * 양방향 이웃 — 관계는 방향이 있지만 **탐색은 양쪽으로 간다.**
   * "신민회를 세운 사람은?" 은 FOUNDED 를 거꾸로 타야 답이 나온다.
   */
  neighbors(id: string): { edge: GraphEdge; other: string; dir: "out" | "in" }[] {
    return [
      ...(this.outs.get(id) ?? []).map((e) => ({ edge: e, other: e.to, dir: "out" as const })),
      ...(this.ins.get(id) ?? []).map((e) => ({ edge: e, other: e.from, dir: "in" as const })),
    ];
  }
}

/**
 * 씨앗에서 n홉까지 넓히며 **탄 경로를 전부 기록한다.**
 *
 * 허브는 **경유를 막고 목적지로는 허용한다** — "김구가 이끈 조직은?" 은 답해야 하지만,
 * 김구를 지나 근현대 인물 전원에 닿는 것은 다리가 아니라 지름길이다.
 */
export function collect(
  g: HistoryGraph,
  seeds: string[],
  budget: { maxHops: number; maxNodes: number; perKind: number } | undefined = BUDGET,
): Collected {
  const b = budget ?? BUDGET;
  const paths = new Map<string, Hop[]>();
  const order: string[] = [];
  let dropped = 0, blocked = 0;

  for (const s of seeds) {
    if (g.node(s) && !paths.has(s)) { paths.set(s, []); order.push(s); }
  }

  const quota = new Map<string, number>();
  const take = (kind: EdgeKind) => {
    const used = quota.get(kind) ?? 0;
    if (used >= b.perKind) return false;
    quota.set(kind, used + 1);
    return true;
  };

  let frontier = [...order];
  for (let hop = 0; hop < b.maxHops && order.length < b.maxNodes; hop++) {
    const next: string[] = [];
    for (const cur of frontier) {
      // **허브는 지나가지 못한다.** 씨앗이면 예외 — 출발점까지 막으면 답을 못 한다
      if (g.hubs.has(cur) && !seeds.includes(cur)) { blocked++; continue; }
      for (const { edge, other, dir } of g.neighbors(cur)) {
        if (paths.has(other)) continue;
        if (order.length >= b.maxNodes) { dropped++; continue; }
        if (!take(edge.kind)) { dropped++; continue; }
        paths.set(other, [...(paths.get(cur) ?? []), { from: cur, to: other, kind: edge.kind, dir }]);
        order.push(other);
        next.push(other);
      }
    }
    if (!next.length) break;
    frontier = next;
  }

  return { nodes: order, paths, dropped, blocked };
}

/** 사람이 읽는 경로 한 줄 — "안창호 ─설립─▶ 신민회 ─영향◀─ 105인 사건" */
export function describePath(path: Hop[]): string {
  if (!path.length) return "";
  let s = path[0].from;
  for (const h of path) s += ` ─${KIND_LABEL[h.kind]}${h.dir === "out" ? "─▶" : "◀─"} ${h.to}`;
  return s;
}
