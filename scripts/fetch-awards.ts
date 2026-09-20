/**
 * 위키데이터 → data/awards.json
 *
 *   node scripts/fetch-awards.ts
 *
 * ── 왜 별도 출처인가 ────────────────────────────────────────────────
 * TMDB 에는 수상 정보가 없다 (응답 필드를 전부 확인했다).
 * 그런데 사용자 질문의 상당수가 수상을 묻는다 —
 * "송강호가 출연한 영화 중 칸 황금종려상을 받은 작품은?"
 *
 * 위키데이터에 **P4947 = TMDB 영화 ID** 가 있어서, 제목으로 어림짐작하지 않고
 * **ID 로 정확히 결합**할 수 있다. 제목 대조는 《괴물》 같은 동명이작에서
 * 조용히 틀린다 — 법령판에서 "이름이 같아도 종류가 다르면 다른 노드" 라고
 * 못 박았던 것과 같은 함정이다.
 *
 * 키가 필요 없고, 질의 시점이 아니라 **색인 시점에 한 번** 받아 굳힌다.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DATA = join(import.meta.dirname, "..", "data");
const UA = { "User-Agent": "movie-navigator/0.1 (portfolio study project)" };

const raw = JSON.parse(await readFile(join(DATA, "raw.json"), "utf-8"));
const ids: string[] = raw.movies.map((m: any) => String(m.id));
/**
 * 인물 수상도 받는다 — "전도연이 칸 여우주연상을 받은 영화는?" 은 **인물**의 상이다.
 * 배우만이 아니다. 감독·각본가도 상을 받는다 (아래 질의의 직업 목록 참고).
 */
const names: string[] = [...new Set<string>(raw.people.map((p: any) => String(p.name)))].filter((n: string) => /[가-힣]/.test(n));

async function sparql(q: string, ms = 60000): Promise<any[]> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), {
      headers: UA, signal: c.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).results.bindings;
  } finally { clearTimeout(t); }
}

/** 공개 엔드포인트는 무거운 질의에서 타임아웃한다. 잘게 나눠 던진다. */
const CHUNK = 120;
const out: Record<string, { award: string; year: number | null }[]> = {};
let failed = 0;

console.log("═".repeat(64));
console.log(`  수상 정보 수집 — 대상 ${ids.length}편 (위키데이터, 키 불필요)`);
console.log("═".repeat(64));

for (let i = 0; i < ids.length; i += CHUNK) {
  const part = ids.slice(i, i + CHUNK);
  const q = `
SELECT ?tmdb ?awardLabel ?year WHERE {
  VALUES ?tmdb { ${part.map((x) => `"${x}"`).join(" ")} }
  ?film wdt:P4947 ?tmdb ; p:P166 ?st .
  ?st ps:P166 ?award .
  OPTIONAL { ?st pq:P585 ?d . BIND(YEAR(?d) AS ?year) }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ko,en". }
}`;
  try {
    // 공개 엔드포인트는 502 를 종종 던진다. 한 구간 실패로 전체를 버리지 않는다.
    let rows: any[] | null = null;
    for (let t = 0; t < 3 && !rows; t++) {
      try { rows = await sparql(q); }
      catch (e) {
        if (t === 2) throw e;
        await new Promise((r) => setTimeout(r, 3000 * (t + 1)));
      }
    }
    rows = rows!;
    for (const r of rows) {
      const k = r.tmdb.value;
      (out[k] ??= []).push({ award: r.awardLabel.value, year: r.year ? Number(r.year.value) : null });
    }
    process.stdout.write(`\r   ${Math.min(i + CHUNK, ids.length)}/${ids.length}편…`);
  } catch (e) {
    failed++;
    process.stdout.write(`\r   ${i}편 구간 실패(${(e as Error).message}) — 계속\n`);
  }
  await new Promise((r) => setTimeout(r, 900));   // 공개 엔드포인트 예의
}

// 중복 제거 (같은 상이 여러 문장으로 들어 있는 경우가 있다)
for (const k of Object.keys(out)) {
  const seen = new Set<string>();
  out[k] = out[k].filter((a) => {
    const key = `${a.award}|${a.year ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}



// ── 인물 수상 ────────────────────────────────────────────────────────
//
// 영화가 받은 상과 사람이 받은 상은 다르다. 《밀양》의 수상 기록에는
// "칸 영화제 여우주연상" 이 없다 — 그건 전도연이 받은 상이기 때문이다.
// 다행히 수상 자격(P1686 = 수상 작품)에 작품이 달려 있고, 그 작품에서
// TMDB ID 까지 따라갈 수 있어 우리 그래프와 정확히 이어진다.
console.log("\n\n  인물 수상 수집…");
const byPerson: Record<string, { award: string; year: number | null; forTmdb: string | null; forTitle: string | null }[]> = {};
const PCHUNK = 40;
for (let i = 0; i < names.length; i += PCHUNK) {
  const part = names.slice(i, i + PCHUNK);
  const q = `
SELECT ?name ?awardLabel ?year ?tmdb ?forLabel WHERE {
  VALUES ?name { ${part.map((n) => `"${n.replace(/"/g, "")}"@ko`).join(" ")} }
  ?p rdfs:label ?name ; wdt:P106 ?occ ; p:P166 ?st .
  # 직업 필터는 **동명이인**을 걸러내려고 둔다. 그런데 배우(Q33999)만 보고 있어서
  # 감독·각본가가 통째로 빠졌다 — 이창동의 칸 각본상이 그래서 없었다.
  # "이창동 감독이 《시》로 받은 상은?" 에 답하려면 감독·각본가도 봐야 한다.
  VALUES ?occ { wd:Q33999 wd:Q2526255 wd:Q28389 wd:Q3282637 }
  ?st ps:P166 ?award .
  OPTIONAL { ?st pq:P1686 ?for . OPTIONAL { ?for wdt:P4947 ?tmdb } }
  OPTIONAL { ?st pq:P585 ?d . BIND(YEAR(?d) AS ?year) }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ko,en". }
}`;
  try {
    let rows: any[] | null = null;
    for (let t = 0; t < 3 && !rows; t++) {
      try { rows = await sparql(q); }
      catch (e) { if (t === 2) throw e; await new Promise((r) => setTimeout(r, 3000 * (t + 1))); }
    }
    for (const r of rows!) {
      const k = r.name.value;
      (byPerson[k] ??= []).push({
        award: r.awardLabel.value,
        year: r.year ? Number(r.year.value) : null,
        forTmdb: r.tmdb?.value ?? null,
        forTitle: r.forLabel?.value ?? null,
      });
    }
    process.stdout.write(`\r   ${Math.min(i + PCHUNK, names.length)}/${names.length}명…`);
  } catch {
    process.stdout.write(`\r   ${i}명 구간 실패 — 계속\n`);
  }
  await new Promise((r) => setTimeout(r, 900));
}
for (const k of Object.keys(byPerson)) {
  const seen = new Set<string>();
  byPerson[k] = byPerson[k].filter((a) => {
    const key = `${a.award}|${a.year ?? ""}|${a.forTmdb ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

const total = Object.values(out).reduce((a, b) => a + b.length, 0);
const ptotal = Object.values(byPerson).reduce((a, b) => a + b.length, 0);
await writeFile(
  join(DATA, "awards.json"),
  JSON.stringify({ fetchedAt: new Date().toISOString(), awards: out, personAwards: byPerson }),
  "utf-8",
);

console.log(`\n\n  영화 수상 ${total}건 · 수상작 ${Object.keys(out).length}편 / ${ids.length}편`);
console.log(`  인물 수상 ${ptotal}건 · 수상자 ${Object.keys(byPerson).length}명 / ${names.length}명`);
if (failed) console.log(`  ⚠️ 실패한 구간 ${failed}개 — 다시 돌리면 채워진다`);
console.log(`  저장: data/awards.json`);
console.log("═".repeat(64));
