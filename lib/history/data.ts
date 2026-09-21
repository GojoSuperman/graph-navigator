/** 그래프를 한 번만 읽어 재사용한다 (서버 컴포넌트가 매 요청 읽지 않도록) */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { HistoryGraph } from "./graph.ts";

let cached: HistoryGraph | null = null;
export async function loadHistoryGraph(): Promise<HistoryGraph> {
  if (!cached) {
    const p = join(process.cwd(), "data", "history", "graph.json");
    cached = new HistoryGraph(JSON.parse(await readFile(p, "utf-8")));
  }
  return cached;
}

/**
 * 문서 본문 — **BM25 색인용.**
 *
 * 처음엔 BM25 가 노드 이름만 색인했다. 그래서 "실학을 연구한 학자는?" 처럼
 * **개체 이름이 없는 질문**을 아예 못 받았다. 평가의 BM25 대조군은 본문을
 * 색인하는데 정작 서비스 경로의 BM25 는 이름만 봤다 — **같은 이름의 다른 물건**이었다.
 *
 * 실측(질문 5개): 이름 색인은 "임진왜란 때 수군을 이끈 장수는?" 에 임진왜란만 냈고,
 * 본문 색인은 **이순신** 을 3위로 냈다.
 */
let docsCache: Map<string, string> | null = null;
export async function loadHistoryDocs(): Promise<Map<string, string>> {
  if (docsCache) return docsCache;
  const dir = join(process.cwd(), "data", "history", "docs");
  const m = new Map<string, string>();
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(".md"))) {
    const raw = await readFile(join(dir, f), "utf-8");
    const t = raw.match(/^# (.+)$/m)?.[1];
    if (t) m.set(t, raw.split(/\n\n/).slice(1).join("\n\n"));
  }
  docsCache = m;
  return m;
}
