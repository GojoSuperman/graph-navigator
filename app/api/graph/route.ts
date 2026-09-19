/** 시각화용 얇은 그래프 — 줄거리를 빼고 좌표·라벨에 필요한 것만 */
import { loadGraph } from "@/lib/data.ts";

export const runtime = "nodejs";

export async function GET() {
  const g = await loadGraph();
  const movies = [...g.movies.values()]
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 600);
  const keep = new Set(movies.map((m) => m.id));
  return Response.json({
    nodes: movies.map((m) => ({
      id: m.id,
      title: m.title,
      year: m.year,
      korean: m.originalLanguage === "ko",
      genres: m.genres.slice(0, 2),
    })),
    // 인물을 사이에 둔 영화–영화 연결 (같은 사람이 나온 두 작품)
    links: (() => {
      const out: { a: string; b: string; via: string }[] = [];
      const seen = new Set<string>();
      for (const p of g.people.values()) {
        const fs = [...new Set(g.filmsOf(p.id, "ACTED_IN").map((e) => e.to))].filter((id) => keep.has(id));
        if (fs.length < 2 || fs.length > 12) continue;   // 허브가 화면을 덮지 않게
        for (let i = 0; i < fs.length; i++) {
          for (let j = i + 1; j < fs.length; j++) {
            const k = `${fs[i]}|${fs[j]}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ a: fs[i], b: fs[j], via: p.name });
          }
        }
      }
      return out.slice(0, 4000);
    })(),
  });
}
