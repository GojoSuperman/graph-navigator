/**
 * 한국어 위키백과 → 한국사(조선~현대) 코퍼스.
 *
 *   node scripts/history/fetch-wiki.ts
 *
 * 시드에서 2홉까지 넓혀 data/history/docs 에 md 로 저장한다.
 * HTML 크롤링·파싱은 하지 않는다 — MediaWiki API 만 쓴다.
 *
 * **왜 2홉인가.** 1홉(시드가 직접 링크한 문서)만 모으면 시드끼리만 이어진 별 모양이
 * 되어 "A와 B 사이의 다리" 질문을 만들 수 없다. 2홉을 넣어야 시드가 아닌 인물이
 * 두 시드를 잇는 구조가 생긴다 — 멀티홉을 증명하려면 그 구조가 있어야 한다.
 *
 * **왜 시대별 할당인가.** 600년을 한 통에 넣고 상위부터 채우면 문서가 많은 현대사로
 * 쏠려 조선 전기가 비어 버린다. 시대마다 몫을 따로 둔다.
 */

import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// ── 시드 — 네 시대 × 각 7건 ──────────────────────────────────────────────
//
// 시대마다 인물·조직·사건 세 타입을 **섞는다.** 인물만 넣으면 2홉 후보도 인물로
// 쏠려 Organization·Event 노드가 빈약해진다. 스키마가 세 타입이면 씨앗도 셋이다.
const SEEDS_BY_ERA = {
  "조선 전·중기": ["세종", "이순신", "정도전", "집현전", "훈민정음", "임진왜란", "성균관"],
  // **이 시대만 15건이다.** 7건으로 돌려 보니 분류를 통과한 2홉 후보가 11건뿐이라
  // 할당 35 를 못 채우고 16건에서 멈췄다(다른 시대는 173·240·34건). 후보가 없는
  // 것이지 풀이 작은 것이 아니었으므로, 풀을 키우는 대신 **시드를 늘렸다.**
  "조선 후기": [
    "정약용", "정조", "흥선대원군", "규장각", "실학", "동학 농민 혁명", "갑오개혁",
    "김정희", "박지원 (1737년)", "박제가", "영조",   // 인물
    "비변사", "장용영",                              // 조직
    "세도정치", "신유박해",                           // 사건
  ],
  "구한말·일제": ["안창호", "김구", "안중근", "신민회", "대한민국 임시정부", "3·1 운동", "의열단"],
  "해방·현대": ["이승만", "박정희", "김대중", "4·19 혁명", "5·18 광주 민주화 운동", "6월 항쟁", "대한민국 제헌 국회"],
} as const;

type Era = keyof typeof SEEDS_BY_ERA;
const ERAS = Object.keys(SEEDS_BY_ERA) as Era[];
const SEEDS = ERAS.flatMap((e) => SEEDS_BY_ERA[e] as readonly string[]);
const ERA_OF_SEED = new Map<string, Era>(
  ERAS.flatMap((e) => (SEEDS_BY_ERA[e] as readonly string[]).map((s) => [s, e] as const)),
);

const API = "https://ko.wikipedia.org/w/api.php";
// User-Agent 에 한글을 넣으면 인코딩 오류가 난다. 아스키로만 쓴다.
const UA = "graph-navigator/0.1 (history corpus study project; contact via github.com/GojoSuperman)";

const PER_ERA = 35;              // 시대당 목표. 4시대 × 35 = 140건
const MIN_CHARS = 800;           // 이보다 짧으면 토막글로 보고 버린다
const POOL = 300;                // 분류 대조에 올릴 2홉 후보 상한 — **시대마다** 이만큼
const GAP = 700;                 // 호출 간격(ms). 300 으로는 429 를 맞았다
const OUT = join(import.meta.dirname, "..", "..", "data", "history");
// 1·2단계(링크 수집·분류 대조) 결과. 3단계에서 죽어도 여기부터 다시 긁지 않는다.
const CACHE = join(OUT, "candidates.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 429 대응 ────────────────────────────────────────────────────────────
//
// 첫 실행은 0.3초 간격으로 돌리다 시드 4번째에서 `429 Too Many Requests` 로 멈췄다.
// 시드가 28건으로 늘었으니 그대로 두면 반드시 다시 막힌다. 셋으로 받친다 —
//   ① 간격을 0.7초로 올린다
//   ② maxlag 를 붙여 서버가 밀릴 때는 스스로 물러선다 (MediaWiki 권장)
//   ③ 429/503 을 만나면 Retry-After 를 **존중**하고, 없으면 지수 백오프로 물러선다
let throttled = 0; // 몇 번 물러섰는지 — 리포트에 찍는다

async function call(params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ format: "json", formatversion: "2", maxlag: "5", ...params });
  for (let attempt = 0; attempt < 8; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${API}?${qs}`, { headers: { "User-Agent": UA } });
    } catch (e: any) {
      // **첫 실행이 여기서 통째로 죽었다** — 45건째에 ENETUNREACH.
      // 429 만 재시도하고 fetch 자체가 던지는 예외는 안 받고 있었다.
      // 네트워크 끊김은 영구 오류가 아니다. 물러섰다 다시 붙는다.
      throttled++;
      const wait = Math.min(2 ** attempt * 1000, 30_000);
      const code = e?.cause?.code ?? e?.code ?? "오류";
      console.log(`\n  ⏸ 네트워크 ${code} — ${Math.round(wait / 1000)}초 쉬고 재시도 (${attempt + 1}/8)`);
      await sleep(wait);
      continue;
    }
    if (res.ok) {
      const json: any = await res.json();
      // maxlag 초과는 200 에 error 로 온다 — 이것도 물러설 신호다
      if (json.error?.code === "maxlag") {
        throttled++;
        await sleep(Math.min(2 ** attempt * 1000, 30_000));
        continue;
      }
      return json;
    }
    if (res.status === 429 || res.status === 503) {
      throttled++;
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(2 ** attempt * 1000, 30_000);
      console.log(`\n  ⏸ ${res.status} — ${Math.round(wait / 1000)}초 쉬고 재시도 (${attempt + 1}/8)`);
      await sleep(wait);
      continue;
    }
    throw new Error(`${res.status} ${res.statusText} — ${params.titles ?? ""}`);
  }
  throw new Error(`재시도 8회 실패 — ${params.titles ?? ""}`);
}

/** 문서 별칭(리다이렉트) — §5 의 별칭 병합이 이걸 쓴다. 지금 안 받으면 나중에 다시 훑어야 한다. */
const aliases = new Map<string, string[]>();

/** API 한 번. continue 가 있으면 이어 받아 합친다. */
async function api(params: Record<string, string>): Promise<any[]> {
  const pages: any[] = [];
  let cont: Record<string, string> = {};
  for (let guard = 0; guard < 20; guard++) {
    const json = await call({ ...params, ...cont });
    pages.push(...(json.query?.pages ?? []));
    for (const r of json.query?.redirects ?? []) {
      if (!aliases.has(r.to)) aliases.set(r.to, []);
      aliases.get(r.to)!.push(r.from);
    }
    if (!json.continue) break;
    cont = json.continue;
    await sleep(GAP);
  }
  return pages;
}

/**
 * 후보에서 걸러낼 문서. 연도·목록·틀·분류 문서는 관계를 만들지 않는다.
 *
 * "1919년" 같은 연도 문서는 링크가 수천 개라 그래프에 들어오면 **모든 인물을
 * 서로 이어 버리는 허브**가 된다. 다리가 아니라 지름길이 생기는 것이다.
 */
// `4월 19일` 같은 **월-일 문서**도 연도 문서와 똑같은 허브다. 첫 수집에서 `4월 19일`
// 과 `6월 10일` 이 들어와 있었다 — 4·19 관련 인물 전원이 그 날짜를 거쳐 2홉 이웃이 된다.
const JUNK = /^(\d+년|\d+년대|\d+세기|\d+월\s*\d+일|\d+월$|.*\s목록$|목록:|틀:|분류:|위키프로젝트|.*\s일람$)/;
const isJunk = (t: string) => JUNK.test(t.trim());

/**
 * 분류 중 **주제를 말하지 않는 것**을 걷어낸다.
 *
 * 이걸 안 하면 채택 필터가 통째로 무력해진다. 실측 — 문서 45건을 받아 보니
 * `위키데이터 속성 P1273을 사용하는 문서` 와 `해결되지 않은 속성이 있는 문서` 가
 * **45/45건 전부**에 붙어 있었다. 분류 등장 1,673회 중 **43%가 이런 유지보수 분류**다.
 * "시드와 분류 1개 이상 공유" 가 위키백과의 아무 문서나 통과시키고 있었다
 * (분류 대조 100건 → 통과 104건, 통과율 100%).
 *
 * 걷어낸 뒤 다시 재니 의도한 대로 갈렸다 —
 *   안창호↔김구 7개 공유(같은 시대) · 안창호↔세종 0개(600년 차이) · 세종↔정약용 4개
 */
const MAINT = /(문서$|^CS1|틀$|^모든\s|웹아카이브|위키데이터|출처가 필요|정확성)/;
/** 유지보수는 아니지만 너무 넓어 "같은 주제" 의 근거가 못 되는 것 */
const BROAD = /^(\d+년 (출생|사망)|\d+세기 .*사람|병사한 사람|암살당한 .*)$/;
const isTopical = (c: string) => !MAINT.test(c) && !BROAD.test(c);

const bar = (s: string) => process.stdout.write(`\r${s.padEnd(78)}`);

interface Shared { title: string; era: Era; seeds: number; cats: number }

/** ①② 시드 링크 수집 → 시대 배정 → 분류 대조. 결과는 캐시된다. */
async function survey(): Promise<Shared[]> {
  // ── ① 시드의 본문 링크를 모은다 (2홉 후보) ──────────────────────────
  //
  // 여러 시드가 **함께 가리키는** 문서부터 고른다. 두 시드가 같은 문서를
  // 가리킨다는 것은 그 문서가 둘을 잇는 다리라는 뜻이다.
  const linkedBy = new Map<string, Set<string>>();
  for (const era of ERAS) {
    for (const seed of SEEDS_BY_ERA[era] as readonly string[]) {
      const pages = await api({
        action: "query", prop: "links", plnamespace: "0", pllimit: "max",
        titles: seed, redirects: "1",
      });
      const links = pages.flatMap((p) => p.links ?? []).map((l: any) => l.title);
      for (const t of links) {
        if (isJunk(t) || SEEDS.includes(t)) continue;
        if (!linkedBy.has(t)) linkedBy.set(t, new Set());
        linkedBy.get(t)!.add(seed);
      }
      console.log(`  [${era}] ${seed.padEnd(18)} 링크 ${links.length}`);
      await sleep(GAP);
    }
  }
  const multi = [...linkedBy.values()].filter((s) => s.size >= 2).length;
  console.log(`\n2홉 후보 ${linkedBy.size}건 (2개 이상 시드가 가리킨 것 ${multi}건)`);

  // 후보를 시대에 배정한다 — 그 후보를 가리킨 시드가 가장 많은 시대로.
  const eraOf = (t: string): Era => {
    const n = new Map<Era, number>();
    for (const s of linkedBy.get(t) ?? []) {
      const e = ERA_OF_SEED.get(s)!;
      n.set(e, (n.get(e) ?? 0) + 1);
    }
    return ERAS.reduce((best, e) => ((n.get(e) ?? 0) > (n.get(best) ?? 0) ? e : best), ERAS[0]);
  };

  // ── ② 분류를 공유하는 것만 남긴다 ────────────────────────────────────
  //
  // 링크가 있다고 같은 주제가 아니다. 안창호 문서는 '미국'도 링크한다.
  // 분류(category)를 하나 이상 공유해야 같은 영역으로 본다.
  //
  // **분류는 시대별로 따로 모은다.** 600년치를 한 통에 넣으면 조선 후보가
  // 현대 시드의 분류로 통과해 버린다. 시대 안에서만 대조한다.
  //
  // 분류는 20건씩 묶어 받을 수 있으므로 **여기서 먼저 거르고** 본문은 살아남은
  // 것만 한 건씩 받는다 — 호출 수가 수백 번 줄어든다.
  const catsOfEra = new Map<Era, Set<string>>();
  for (const era of ERAS) {
    const pages = await api({
      action: "query", prop: "categories", cllimit: "max",
      titles: (SEEDS_BY_ERA[era] as readonly string[]).join("|"), redirects: "1",
    });
    const set = new Set<string>();
    let raw = 0;
    for (const p of pages) for (const c of p.categories ?? []) {
      raw++;
      const t = c.title.replace(/^분류:/, "");
      if (isTopical(t)) set.add(t);
    }
    catsOfEra.set(era, set);
    console.log(`  [${era}] 시드 분류 ${set.size}종 (유지보수 ${raw - set.size}건 제외)`);
    await sleep(GAP);
  }

  // 전체에서 상위 N 을 자르면 **시드가 많은 시대가 풀을 독식한다.** 조선 후기 후보가
  // 링크 수 하위라 잘려 나가고 있었다. 시대마다 따로 잘라 같은 기회를 준다.
  const pool: string[] = [];
  for (const era of ERAS) {
    const inEra = [...linkedBy.keys()]
      .filter((t) => eraOf(t) === era)
      .sort((a, b) => (linkedBy.get(b)!.size - linkedBy.get(a)!.size))
      .slice(0, POOL);
    pool.push(...inEra);
    console.log(`  [${era}] 후보 ${inEra.length}건 대조 예정`);
  }

  const shared: Shared[] = [];
  for (let i = 0; i < pool.length; i += 20) {
    const batch = pool.slice(i, i + 20);
    const pages = await api({
      action: "query", prop: "categories", cllimit: "max",
      titles: batch.join("|"), redirects: "1",
    });
    for (const p of pages) {
      if (!p.title || p.missing) continue;
      const era = eraOf(p.title);
      const want = catsOfEra.get(era)!;
      const cats = (p.categories ?? [])
        .map((c: any) => c.title.replace(/^분류:/, ""))
        .filter(isTopical);
      const hit = cats.filter((c: string) => want.has(c));
      if (hit.length) {
        shared.push({ title: p.title, era, seeds: linkedBy.get(p.title)?.size ?? 0, cats: hit.length });
      }
    }
    const seen = Math.min(i + 20, pool.length);
    bar(`  분류 대조 ${seen}/${pool.length} → 통과 ${shared.length}건 (${Math.round(shared.length / seen * 100)}%)`);
    await sleep(GAP);
  }
  console.log(`\n분류를 공유한 후보 ${shared.length}건`);
  for (const era of ERAS) console.log(`  [${era}] ${shared.filter((c) => c.era === era).length}건`);
  return shared;
}

async function main() {
  await mkdir(join(OUT, "docs"), { recursive: true });
  console.log(`시드 ${SEEDS.length}건 · ${ERAS.length}시대 · 목표 ${PER_ERA * ERAS.length}건\n`);

  // ── ①② 후보 조사 — **캐시가 있으면 건너뛴다** ─────────────────────
  //
  // 1·2단계는 호출이 80번쯤 되는데, 3단계(본문 받기)에서 죽으면 그게 전부 헛일이
  // 된다. 실제로 첫 실행이 45건째에 네트워크가 끊겨 죽었다. 결과를 파일에 남겨
  // 두고 다시 돌릴 때 재사용한다.
  let shared: Shared[];
  const cached: any = await readFile(CACHE, "utf-8").then(JSON.parse).catch(() => null);
  if (cached?.shared?.length) {
    shared = cached.shared;
    for (const [k, v] of Object.entries(cached.aliases ?? {})) aliases.set(k, v as string[]);
    console.log(`후보 캐시 재사용 — ${shared.length}건 (조사 ${cached.surveyedAt})`);
    console.log(`  다시 조사하려면: rm data/history/candidates.json\n`);
  } else {
    shared = await survey();
    await writeFile(CACHE, JSON.stringify({
      surveyedAt: new Date().toISOString(),
      shared,
      aliases: Object.fromEntries(aliases),
    }, null, 2));
  }

  // ── ③ 시대별 할당을 채운다 ───────────────────────────────────────────
  //
  // 시드를 먼저 넣고, 그 시대 후보를 **여러 시드가 가리킨 순서**로 채운다.
  // 다리가 될 가능성이 높은 것부터 들어간다.
  const queue: { title: string; era: Era }[] = [];
  for (const era of ERAS) {
    for (const s of SEEDS_BY_ERA[era] as readonly string[]) queue.push({ title: s, era });
  }
  for (const era of ERAS) {
    // 여러 시드가 가리킨 것 우선, 같으면 분류를 더 많이 공유한 것 우선
    const rest = shared.filter((c) => c.era === era)
      .sort((a, b) => (b.seeds - a.seeds) || (b.cats - a.cats));
    for (const c of rest) queue.push({ title: c.title, era });
  }

  const savedByEra = new Map<Era, string[]>(ERAS.map((e) => [e, []]));
  const saved: { title: string; era: Era }[] = [];
  const skipped: string[] = [];

  // 이미 받아 둔 문서는 다시 받지 않는다 — 시대는 파일 헤더에서 읽는다.
  // (첫 실행이 45건째에 죽었다. 재실행이 처음부터라면 고칠 때마다 대가를 다시 치른다)
  for (const f of await readdir(join(OUT, "docs")).catch(() => [])) {
    if (!f.endsWith(".md")) continue;
    // 600자로 잘랐더니 `시대:` 줄을 놓쳤다 — 분류 목록이 1,500자를 넘는 문서가 있다
    // (안창호는 분류만 60종). 119건 중 62건만 이어받아 57건을 헛으로 다시 받았다.
    const head = (await readFile(join(OUT, "docs", f), "utf-8")).slice(0, 4000);
    const title = head.match(/^# (.+)$/m)?.[1];
    const era = head.match(/^시대: (.+)$/m)?.[1] as Era | undefined;
    if (!title || !era || !ERAS.includes(era)) continue;
    savedByEra.get(era)!.push(title);
    saved.push({ title, era });
  }
  if (saved.length) {
    console.log(`이어받기 — 이미 ${saved.length}건 있음`);
    for (const era of ERAS) console.log(`  [${era}] ${savedByEra.get(era)!.length}/${PER_ERA}`);
    console.log();
  }

  for (const { title, era } of queue) {
    if (savedByEra.get(era)!.length >= PER_ERA) continue;
    if (saved.some((s) => s.title === title)) continue;

    const pages = await api({
      action: "query", prop: "extracts|categories", explaintext: "1", cllimit: "max",
      titles: title, redirects: "1",
    });
    const p = pages[0];
    const text: string = p?.extract ?? "";
    if (!p || p.missing || text.length < MIN_CHARS) {
      skipped.push(`${title} (${text.length}자)`);
      await sleep(GAP);
      continue;
    }
    if (saved.some((s) => s.title === p.title)) { await sleep(GAP); continue; } // 리다이렉트로 겹친 것

    const cats = (p.categories ?? []).map((c: any) => c.title.replace(/^분류:/, "")).join(", ");
    const alias = aliases.get(p.title) ?? [];
    const head = [
      `# ${p.title}`,
      `분류: ${cats}`,
      `시대: ${era}`,
      alias.length ? `별칭: ${alias.join(", ")}` : null,
    ].filter(Boolean).join("\n");
    await writeFile(join(OUT, "docs", `${p.title.replace(/[\s/]/g, "_")}.md`), `${head}\n\n${text}\n`);

    savedByEra.get(era)!.push(p.title);
    saved.push({ title: p.title, era });
    bar(`  저장 ${saved.length}/${PER_ERA * ERAS.length}  [${era}] ${p.title.slice(0, 18)}`);
    await sleep(GAP);
  }

  // ── 리포트 ───────────────────────────────────────────────────────────
  const byEra = Object.fromEntries(ERAS.map((e) => [e, savedByEra.get(e)!.length]));
  await writeFile(
    join(OUT, "manifest.json"),
    JSON.stringify({
      seeds: SEEDS_BY_ERA,
      target: PER_ERA * ERAS.length,
      count: saved.length,
      byEra,
      docs: saved,
      aliases: Object.fromEntries([...aliases].filter(([t]) => saved.some((s) => s.title === t))),
      skipped,
      throttled,
      fetchedAt: new Date().toISOString(),
    }, null, 2),
  );

  console.log(`\n\n저장 ${saved.length}건 · 토막글 등 탈락 ${skipped.length}건 · 물러선 횟수 ${throttled}`);
  for (const era of ERAS) {
    const n = byEra[era];
    console.log(`  ${era.padEnd(12)} ${String(n).padStart(3)}건 ${n < PER_ERA ? `⚠ 할당 ${PER_ERA} 미달` : ""}`);
  }
  console.log(`→ data/history/docs/ · manifest.json`);
}

await main();
