/** 3D 전경형이 받는 한국사 전체 — 영화 `/api/graph` 와 같은 모양 */
import { loadHistoryGraph } from "@/lib/history/data.ts";

export const runtime = "nodejs";

export async function GET() {
  const g = await loadHistoryGraph();
  // 차수 1인 롱테일(807개)까지 뿌리면 구름만 보인다. **연결이 있는 것만** 그린다
  const nodes = [...g.nodes.values()]
    .filter((n) => n.degree >= 2)
    .map((n) => ({ id: n.id, title: n.id, korean: n.type === "Person" }));
  return Response.json({ nodes });
}
