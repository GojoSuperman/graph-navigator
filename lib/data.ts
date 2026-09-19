/**
 * 서버에서 그래프를 한 번만 읽어 재사용한다.
 * import 로 가져오면 큰 JSON 이 타입 추론에 걸려 느려지므로 런타임에 fs 로 읽는다.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MovieGraph } from "./graph.ts";
import type { GraphData } from "./types.ts";

let cached: Promise<MovieGraph> | null = null;

export function loadGraph(): Promise<MovieGraph> {
  cached ??= (async () => {
    const raw = await readFile(join(process.cwd(), "data", "graph.json"), "utf-8");
    return new MovieGraph(JSON.parse(raw) as GraphData);
  })();
  return cached;
}
