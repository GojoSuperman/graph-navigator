/**
 * 3D 에서 노드를 클릭했을 때 뜨는 **근거 카드**.
 *
 *   /api/history/node?id=안창호
 *
 * 영화에서 이 자리는 포스터였다 — "이게 뭔지 한눈에" 가 포스터의 일이다.
 * 한국사에는 포스터가 없고, **그 자리에 있어야 할 것은 근거다.** 이 노드가 왜
 * 여기 있는지, 무슨 문장이 그것을 받치는지가 이 도구의 값어치이기 때문이다.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadHistoryGraph } from "@/lib/history/data.ts";
import { KIND_LABEL, type EdgeKind } from "@/lib/history/config.ts";

export const runtime = "nodejs";

const TYPE_LABEL: Record<string, string> = { Person: "인물", Organization: "조직", Event: "사건" };

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id 가 없습니다" }, { status: 400 });
  const g = await loadHistoryGraph();
  const n = g.node(id);
  if (!n) return Response.json({ error: "그런 개체가 없습니다" }, { status: 404 });

  /**
   * 근거를 고르는 기준 — **양끝 이름이 그 문장에 둘 다 나오는 것부터.**
   *
   * 처음엔 `quotes.length` 순으로 골랐더니 `(안창호) ─이끔─▶ (임시정부)` 의 근거로
   * **사망 경위를 적은 문장**이 뽑혔다. 문장이 실재하기는 하나 그 관계를 말하지
   * 않는다 — §4 에서 확인한 것과 같은 고장이다.
   *
   * 골든셋 선별에 썼던 필터를 여기서도 쓴다. 추출 단계에는 가혹해서 버렸지만
   * **보여 줄 것을 고르는 데는 가혹한 쪽이 맞다.**
   */
  const key = (x: string) => x.replace(/[·・.\s]|\(.+?\)/g, "");
  const solidity = (q: string, a: string, b: string) => {
    const k = key(q);
    return (k.includes(key(a)) ? 1 : 0) + (k.includes(key(b)) ? 1 : 0);
  };

  const evidence = g.neighbors(n.id)
    .filter(({ edge }) => edge.quotes.length)
    .map(({ edge, other, dir }) => {
      const from = dir === "out" ? n.id : other;
      const to = dir === "out" ? other : n.id;
      // 여러 근거가 있으면 **가장 잘 받치는 문장**을 고른다
      const quote = [...edge.quotes].sort((x, y) => solidity(y, from, to) - solidity(x, from, to))[0];
      return {
        from, to, quote,
        kind: KIND_LABEL[edge.kind as EdgeKind] ?? edge.kind,
        doc: edge.docs[0] ?? null,
        score: solidity(quote, from, to) * 10 + edge.quotes.length,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(({ score, ...e }) => e);

  /**
   * **위키백과 본문 앞부분.**
   *
   * 처음엔 삼중항만 띄웠는데 "어떤 의미인지 전혀 모르겠다" 는 말이 나왔다.
   * 맞는 지적이다 — `(김구) ─이끔─▶ (국민대표회의)` 만 보고 그게 무엇인지 알 수
   * 없다. 개체가 **무엇인지**를 먼저 알려 주고, 관계는 그 뒤에 붙인다.
   *
   * 수집해 둔 문서에서 읽는다 — 네트워크를 타지 않는다. 문서가 있는 것은
   * 1,135개 중 112개뿐이고, 없으면 근거 문장이 그 자리를 대신한다.
   */
  let summary: string | null = null;
  try {
    const file = `${n.id.replace(/[\s/]/g, "_")}.md`;
    const raw = await readFile(join(process.cwd(), "data", "history", "docs", file), "utf-8");
    const body = raw.split(/\n\n/).slice(1).join("\n\n").trim();
    // 두세 문장까지 — 모달이 포스터만 한 크기여야 한다
    const cut = body.slice(0, 460);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("다."), cut.lastIndexOf("다\n"));
    summary = (end > 120 ? cut.slice(0, end + 2) : cut).replace(/\s+/g, " ").trim();
  } catch { /* 문서가 없는 개체 — 근거가 대신한다 */ }

  return Response.json({
    id: n.id,
    summary,
    type: TYPE_LABEL[n.type] ?? n.type,
    era: n.era,
    degree: n.degree,
    aliases: n.aliases,
    isHub: g.hubs.has(n.id),
    evidence,
    /** 원문으로 나가는 문 — 근거를 의심하는 사람이 1초에 확인할 수 있어야 한다 */
    wiki: `https://ko.wikipedia.org/wiki/${encodeURIComponent(n.id.replace(/\s/g, "_"))}`,
  });
}
