/** 그래프를 한 번만 읽어 재사용한다 (서버 컴포넌트가 매 요청 읽지 않도록) */
import { readFile } from "node:fs/promises";
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
