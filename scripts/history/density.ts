/**
 * 1.5단계 — 밀도 게이트.
 *
 *   node scripts/history/density.ts
 *
 * **왜 LLM 추출 전에 재는가.** 밀도가 모자라면 그 뒤가 전부 헛일이 된다. 추출·정제를
 * 다 하고 나서 "다리가 없다" 를 발견하면 되돌릴 것이 많다. 그래서 돈을 쓰기 전에
 * 코퍼스만으로 잴 수 있는 것을 먼저 잰다.
 *
 * **무엇을 대신 재는가.** 진짜 엣지는 아직 없다. 대신 **언급 그래프**를 쓴다 —
 * A 문서 본문에 B 문서 제목이 나오면, 그 자리에 관계 서술이 있을 가능성이 높다.
 * 언급이 없으면 LLM 도 뽑을 수 없으므로, 이것은 **엣지 수의 상한**이기도 하다.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "..", "..", "data", "history");
const ERAS = ["조선 전·중기", "조선 후기", "구한말·일제", "해방·현대"] as const;
type Era = (typeof ERAS)[number];

// ── 통과 기준 — **결과를 보기 전에 정한다** ───────────────────────────────
//
// 보고 나서 정하면 무슨 숫자가 나와도 통과시키게 된다.
const GATE = {
  // 2홉 경로가 서려면 중간 노드가 양쪽으로 연결돼 있어야 한다. 여유를 둬 5.
  avgDegree: 5,
  // 그래프가 쪼개지면 조각 안에서만 질문이 된다. 큰 덩어리가 8할은 돼야 한다.
  largestComponentRatio: 0.8,
  // 골든셋의 멀티홉이 24문항(2홉 14 · 3홉 6 · 시대교차 4). 고를 여지가 있으려면
  // 다리 후보가 그 두 배는 필요하다.
  bridges: 50,
  // 한 시대 안에서 질문이 만들어지려면 시대 내부 엣지가 있어야 한다.
  edgesPerEra: 50,
};

interface Doc { title: string; era: Era; aliases: string[]; body: string; isSeed: boolean }

/**
 * 이름 하나가 본문에 나타날 수 있는 표기들.
 *
 * 처음엔 본문과 이름에서 공백·중점을 **지워서** 맞췄는데 양쪽으로 틀렸다 —
 *   ① 과다: "제독이 이끄는" → "제독이이끄는" 이 되어 《이이》가 매칭됐다.
 *           두 글자 제목이 27건이라 (조선·세종·정조·김구…) 차수가 통째로 부풀었다.
 *   ② 누락: 본문은 "31운동" 이 되는데 찾는 이름은 "3·1운동" 이라 영영 안 맞았다.
 *           **《3·1 운동》 언급이 0건으로 잡히고 있었다.**
 * 그래서 본문은 그대로 두고 **이름 쪽에 변형을 만들어** 찾는다.
 */
function variants(name: string): string[] {
  const n = name.replace(/\s*\(.+\)$/, "");
  const v = new Set([n, n.replace(/\s/g, "")]);
  if (n.includes("·")) { v.add(n.replace(/·/g, ".")); v.add(n.replace(/·/g, "")); }
  return [...v].filter((x) => x.length >= 2);
}

/**
 * 앞이 한글이 아닐 때만 인정한다. 뒤는 막지 않는다 —
 * "세종대왕"·"조선시대" 는 정당한 언급인데 뒤를 막으면 함께 버려진다 (실측: 세종 43→32).
 */
const rx = (v: string) => new RegExp(`(?<![가-힣])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

async function main() {
  const manifest = JSON.parse(await readFile(join(OUT, "manifest.json"), "utf-8"));
  const seedSet = new Set<string>(Object.values(manifest.seeds).flat() as string[]);
  const aliasMap: Record<string, string[]> = manifest.aliases ?? {};

  const docs: Doc[] = [];
  for (const f of (await readdir(join(OUT, "docs"))).filter((f) => f.endsWith(".md"))) {
    const raw = await readFile(join(OUT, "docs", f), "utf-8");
    const title = raw.match(/^# (.+)$/m)?.[1];
    const era = raw.match(/^시대: (.+)$/m)?.[1] as Era | undefined;
    if (!title || !era) continue;
    // 헤더(제목·분류·시대·별칭)는 본문이 아니다 — 분류에 제목이 들어 있어 자기 언급이 잡힌다
    const body = raw.split(/\n\n/).slice(1).join("\n\n");
    docs.push({ title, era, aliases: aliasMap[title] ?? [], body, isSeed: seedSet.has(title) });
  }

  // ── 언급 그래프 ────────────────────────────────────────────────────────
  //
  const names: { re: RegExp; target: string }[] = [];
  for (const d of docs) {
    for (const n of [d.title, ...d.aliases]) {
      for (const v of variants(n)) names.push({ re: rx(v), target: d.title });
    }
  }

  const out = new Map<string, Set<string>>(docs.map((d) => [d.title, new Set()]));
  for (const d of docs) {
    for (const { re, target } of names) {
      if (target === d.title || out.get(d.title)!.has(target)) continue;
      if (re.test(d.body)) out.get(d.title)!.add(target);
    }
  }

  const eraOf = new Map(docs.map((d) => [d.title, d.era]));
  const edges = [...out].flatMap(([a, bs]) => [...bs].map((b) => [a, b] as const));
  const mutual = edges.filter(([a, b]) => out.get(b)!.has(a)).length / 2;

  // 무방향 차수 (양쪽 중 한쪽만 언급해도 연결로 본다)
  const undirected = new Map<string, Set<string>>(docs.map((d) => [d.title, new Set()]));
  for (const [a, b] of edges) { undirected.get(a)!.add(b); undirected.get(b)!.add(a); }
  const degrees = docs.map((d) => undirected.get(d.title)!.size);
  const avgDeg = degrees.reduce((s, n) => s + n, 0) / docs.length;

  // 연결 요소
  const seen = new Set<string>(); const comps: number[] = [];
  for (const d of docs) {
    if (seen.has(d.title)) continue;
    let n = 0; const stack = [d.title];
    while (stack.length) {
      const t = stack.pop()!;
      if (seen.has(t)) continue;
      seen.add(t); n++;
      for (const x of undirected.get(t)!) if (!seen.has(x)) stack.push(x);
    }
    comps.push(n);
  }
  comps.sort((a, b) => b - a);

  // 다리 — **시드가 아니면서 시드 2개 이상과 이어진** 문서. 멀티홉 질문의 재료다.
  const bridges = docs.filter((d) => !d.isSeed &&
    [...undirected.get(d.title)!].filter((t) => docs.find((x) => x.title === t)?.isSeed).length >= 2);

  // 시대 내부 / 시대 교차
  const inEra = new Map<Era, number>(ERAS.map((e) => [e, 0]));
  let cross = 0;
  for (const [a, b] of edges) {
    if (eraOf.get(a) === eraOf.get(b)) inEra.set(eraOf.get(a)!, inEra.get(eraOf.get(a)!)! + 1);
    else cross++;
  }

  // ── 출력 ───────────────────────────────────────────────────────────────
  const L = console.log;
  const pass = (ok: boolean) => (ok ? "✅" : "❌");
  L(`\n문서 ${docs.length}건 · 언급 엣지 ${edges.length}개 (상호 ${mutual}쌍)\n`);

  L("── 게이트 ─────────────────────────────────────────────────");
  const okDeg = avgDeg >= GATE.avgDegree;
  L(`  ${pass(okDeg)} 평균 차수        ${avgDeg.toFixed(1)}  (기준 ${GATE.avgDegree} 이상)`);
  const ratio = comps[0] / docs.length;
  const okComp = ratio >= GATE.largestComponentRatio;
  L(`  ${pass(okComp)} 최대 연결 요소    ${comps[0]}/${docs.length} = ${(ratio * 100).toFixed(0)}%  (기준 ${GATE.largestComponentRatio * 100}% 이상) · 조각 ${comps.length}개`);
  const okBridge = bridges.length >= GATE.bridges;
  L(`  ${pass(okBridge)} 다리 후보        ${bridges.length}건  (기준 ${GATE.bridges} 이상)`);
  let okEra = true;
  for (const e of ERAS) {
    const n = inEra.get(e)!; if (n < GATE.edgesPerEra) okEra = false;
    L(`  ${pass(n >= GATE.edgesPerEra)} [${e}] 내부 엣지 ${String(n).padStart(4)}개  (기준 ${GATE.edgesPerEra} 이상)`);
  }
  L(`     시대를 가로지르는 엣지 ${cross}개 — 설계서가 "얇을 것" 으로 예상한 부분`);

  L("\n── 허브 (탐색에서 통과 금지할 후보 · §5) ───────────────────");
  [...undirected].sort((a, b) => b[1].size - a[1].size).slice(0, 10)
    .forEach(([t, s], i) => L(`  ${String(i + 1).padStart(2)}. ${t.padEnd(24)} 차수 ${s.size}`));

  L("\n── 고립 (아무와도 안 엮인 문서) ────────────────────────────");
  const lone = docs.filter((d) => undirected.get(d.title)!.size === 0);
  L(lone.length ? lone.map((d) => `  ${d.title} [${d.era}]`).join("\n") : "  없음");

  const all = okDeg && okComp && okBridge && okEra;
  L(`\n${all ? "✅ 게이트 통과 — 2단계(LLM 추출)로 간다" : "❌ 게이트 미달 — 시드·범위를 다시 잡는다"}\n`);
  process.exitCode = all ? 0 : 1;
}

await main();
