/**
 * 3D 가 받는 두 번째 입구 — 질문이 아니라 **주제**를 받는다.
 *
 *   /api/focus?movie=movie:496243   작품에서 인물로 뻗는 관계
 *   /api/focus?person=person:20738  그 사람이 잇는 작품들
 *
 * 질문(/api/ask)은 "답을 찾는" 길이고, 이쪽은 "이 주변을 보여 주는" 길이다.
 * 세 페이지가 서로를 몰라도 되도록, 각자 **주제만** 3D 에 넘긴다.
 */
import { loadGraph } from "@/lib/data.ts";

export const runtime = "nodejs";

const LIMIT = 14;

export async function GET(req: Request) {
  const u = new URL(req.url);
  const movieId = u.searchParams.get("movie");
  const personId = u.searchParams.get("person");
  const g = await loadGraph();

  const nodeOf = (id: string, hop: number, isSeed: boolean) => {
    const m = g.movie(id)!;
    return { id, label: m.title, hop, korean: m.originalLanguage === "ko", isSeed };
  };

  // ── 인물 주제 — 그 사람이 잇는 작품들 ──────────────────────────────
  if (personId) {
    const p = g.person(personId);
    if (!p) return Response.json({ error: "그런 인물이 없습니다" }, { status: 404 });
    const films = [...new Set(g.filmsOf(p.id).map((e) => e.to))]
      .map((id) => g.movie(id)!).filter(Boolean)
      .sort((a, b) => b.popularity - a.popularity).slice(0, LIMIT);
    if (!films.length) return Response.json({ error: "연결된 작품이 없습니다" }, { status: 404 });

    // 가장 대표작을 가운데 두고 나머지를 그 사람으로 잇는다
    const [center, ...rest] = films;
    return Response.json({
      subject: `${p.name} 이 잇는 작품`,
      nodes: [nodeOf(center.id, 0, true), ...rest.map((m) => nodeOf(m.id, 1, false))],
      edges: rest.map((m) => ({ from: center.id, to: m.id, via: p.name })),
      refused: false,
    });
  }

  // ── 작품 주제 — 출연·연출 인물을 거쳐 다른 작품으로 ────────────────
  if (movieId) {
    const m = g.movie(movieId);
    if (!m) return Response.json({ error: "그런 작품이 없습니다" }, { status: 404 });

    // 주연·감독부터 — 다리가 굵은 사람 순
    const credits = g.creditsOf(m.id)
      .filter((e) => e.kind === "ACTED_IN" || e.kind === "DIRECTED")
      .sort((a, b) => (a.kind === "DIRECTED" ? -1 : (a.order ?? 99)) - (b.kind === "DIRECTED" ? -1 : (b.order ?? 99)))
      .slice(0, 6);

    const nodes = [nodeOf(m.id, 0, true)];
    const edges: { from: string; to: string; via: string }[] = [];
    const seen = new Set([m.id]);
    for (const c of credits) {
      const p = g.person(c.from);
      if (!p) continue;
      const others = [...new Set(g.filmsOf(p.id).map((e) => e.to))]
        .filter((id) => !seen.has(id))
        .map((id) => g.movie(id)!).filter(Boolean)
        .sort((a, b) => b.popularity - a.popularity).slice(0, 3);
      for (const o of others) {
        if (nodes.length >= LIMIT) break;
        seen.add(o.id);
        nodes.push(nodeOf(o.id, 1, false));
        edges.push({ from: m.id, to: o.id, via: p.name });
      }
      if (nodes.length >= LIMIT) break;
    }
    return Response.json({ subject: `${m.title} 에서 뻗는 관계`, nodes, edges, refused: false });
  }

  return Response.json({ error: "movie 또는 person 이 필요합니다" }, { status: 400 });
}
