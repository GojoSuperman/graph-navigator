/**
 * 3D 가 받는 한국사 주제.
 *
 *   /api/history/focus?id=안창호
 *
 * 영화의 `/api/focus` 와 **같은 모양**(VizNode·VizEdge)을 낸다 — 3D 엔진은
 * 도메인을 몰라도 되게 둔다. `korean` 플래그는 색 두 갈래로만 쓰이므로
 * 여기서는 **인물 / 조직·사건**을 가른다.
 */
import { loadHistoryGraph } from "@/lib/history/data.ts";
import { KIND_LABEL, type EdgeKind } from "@/lib/history/config.ts";

export const runtime = "nodejs";
const LIMIT = 16;

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id 가 없습니다" }, { status: 400 });
  const g = await loadHistoryGraph();
  const seed = g.node(id);
  if (!seed) return Response.json({ error: "그런 개체가 없습니다" }, { status: 404 });

  const nodes = [{ id: seed.id, label: seed.id, hop: 0, isSeed: true, korean: seed.type === "Person" }];
  const edges: { from: string; to: string; via: string }[] = [];

  // 1홉 — 연결이 많은 것부터. 허브는 **경유하지 않으므로** 여기서도 뻗지 않는다
  const near = g.neighbors(seed.id)
    .sort((a, b) => (g.node(b.other)?.degree ?? 0) - (g.node(a.other)?.degree ?? 0))
    .slice(0, LIMIT);
  for (const { edge, other } of near) {
    const n = g.node(other);
    if (!n || nodes.some((x) => x.id === other)) continue;
    nodes.push({ id: other, label: other, hop: 1, isSeed: false, korean: n.type === "Person" });
    edges.push({ from: seed.id, to: other, via: KIND_LABEL[edge.kind as EdgeKind] ?? edge.kind });
  }

  // 2홉 — 1홉 이웃끼리 이어진 것만 그린다. 새 노드를 더 벌리면 화면이 뭉개진다
  for (const { other } of near) {
    for (const { edge, other: far } of g.neighbors(other)) {
      if (!nodes.some((x) => x.id === far) || far === seed.id) continue;
      if (edges.some((e) => (e.from === other && e.to === far) || (e.from === far && e.to === other))) continue;
      edges.push({ from: other, to: far, via: KIND_LABEL[edge.kind as EdgeKind] ?? edge.kind });
    }
  }

  return Response.json({ subject: seed.id, nodes, edges });
}
