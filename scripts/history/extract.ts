/**
 * 2단계 — LLM 관계 추출.
 *
 *   node --env-file-if-exists=.env.local scripts/history/extract.ts [--limit N] [--doc 제목]
 *
 * 문서를 조각내 스키마 안의 관계만 뽑고, **근거 문장이 원문에 실재하는지 코드로
 * 대조해** 통과 못 하면 버린다. 모델이 아는 역사 지식으로 채운 관계는 여기서 걸린다.
 *
 * 결과는 `edges.raw.jsonl` 에 조각 단위로 append 한다 — 죽어도 그 조각부터 다시 한다.
 */

import { readFile, readdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "..", "..", "data", "history");
const RAW = join(OUT, "edges.raw.jsonl");
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const BASE = "https://api.openai.com/v1";
const CHUNK = 6000;        // 조각 목표 크기(자). 문단 경계에서 자른다
const CONCURRENCY = 5;
/**
 * 관계마다 양쪽 노드 타입이 정해져 있다. **코드가 대조한다.**
 *
 * 왜 필요한가 — 스모크 테스트에서 `안창호 -MENTORED-> 대한민국 임시정부` 가 나왔다.
 * MENTORED 는 Person → Person 인데 to 가 조직이다. 전량 추출에서 **197개**를 잡았다. `quote` 원문 대조는 문장이
 * **실재하는지**만 보지 그 문장이 **그 관계를 말하는지**는 못 본다. 타입 서명은
 * 그 틈의 일부를 오탐 없이 막는다.
 *
 * (quote 안에 from·to 이름이 있는지 보는 방법도 재 봤지만 버렸다 — 표기 변형 때문에
 *  정당한 엣지가 대량으로 걸린다. 48개 중 from·to 둘 다 든 것이 10개(20%)뿐이었다.
 *  "대한민국 임시정부" 를 본문은 "임시정부" 라 쓰고, 주어는 "그가" 로 받는다.
 *  그것은 §5 정제가 풀 문제이지 여기서 버릴 일이 아니다.)
 */
const SIGNATURE: Record<string, { from: string[]; to: string[] }> = {
  PARTICIPATED_IN: { from: ["Person"], to: ["Event"] },
  FOUNDED:         { from: ["Person"], to: ["Organization"] },
  MEMBER_OF:       { from: ["Person"], to: ["Organization"] },
  LED:             { from: ["Person"], to: ["Organization", "Event"] },
  AFFECTED:        { from: ["Event"],  to: ["Organization"] },
  STUDIED_UNDER:   { from: ["Person"], to: ["Person"] },   // from=제자, to=스승
};
const KINDS = Object.keys(SIGNATURE);

const SYSTEM = `너는 한국사 문서에서 **지식 그래프의 엣지**를 뽑는 추출기다.

## 노드 타입 (이 셋만)
- Person: 사람 (세종, 정약용, 안창호)
- Organization: 단체·정부·학교·신문 (집현전, 신민회, 대한민국 임시정부)
- Event: 사건·운동·전투·개혁 (임진왜란, 3·1 운동, 갑오개혁)

## 관계 타입 (이 여섯만. **방향을 정확히 지켜라**)

- PARTICIPATED_IN  Person → Event
    그 사건에 참여·참전·가담했다고 본문이 말한 경우.
- FOUNDED          Person → Organization
    그가 그 조직을 설립·창설·조직했다고 본문이 말한 경우.
- MEMBER_OF        Person → Organization
    그가 그 조직에 소속·가입·재직했다고 본문이 말한 경우.
- LED              Person → Organization|Event
    **그가 그 조직·사건의 장(長)·대표·지휘자였다고 본문이 말한 경우만.**
    회장·주석·총리·당수·사령관·위원장으로 재임했다거나, 그 사건을 지휘했다는 서술.
    ✗ "무언가를 했다" 로는 부족하다. 해산시켰다·방문했다·사업을 추진했다·
      관계를 수립했다 는 LED 가 **아니다.**
- AFFECTED         Event → Organization
    **그 사건으로 조직이 해산·탄압·수립·분열됐다고 본문이 명시한 경우만.**
    ✗ 사건을 말하는 문장에 조직이 같이 나왔다는 것으로는 **부족하다.**
- STUDIED_UNDER    Person → Person   (**from 이 제자, to 가 스승**)
    "안창호는 이승훈의 문인이다" → from=안창호, to=이승훈
    "이황에게서 수학하였다"      → from=그 사람, to=이황
    학문·사상을 **배운** 관계만. 가입 권유·소개·천거·동료·교유는 제외한다.
    ✗ 방향을 거꾸로 쓰면 틀린 것이다. **배운 쪽이 from 이다.**
    ⚠ "A의 학문이 B를 거쳐 C로 이어졌다" 는 **A 가 스승**이다.
      → from=B, to=A / from=C, to=B 로 낸다. A 를 from 에 두지 마라.
    ⚠ "친구인 X", "교유하였다", "서신을 주고받았다" 는 사제가 아니다. 내지 마라.

## 반드시 지킬 것
1. **quote 는 주어진 본문에서 글자 그대로 잘라 온다.** 요약·의역·교정 금지.
   한 문장이면 족하다. 본문에 없는 문장을 쓰면 그 엣지는 버려진다.
1-1. **quote 는 그 관계를 직접 서술하는 문장이어야 한다.** 두 개체가 같은 문장에
   나온다고 관계가 있는 것이 아니다. 가능하면 from 과 to 가 **둘 다 나오는** 문장을
   고른다. 관계를 말하는 문장이 없으면 **그 엣지를 내지 마라.**
2. 본문이 **명시적으로 서술한 관계만** 뽑는다. 네가 아는 역사 지식으로 채우지 마라.
3. **관직·직위는 노드가 아니다.** 관찰사·판서·참판·영의정·통제사·절도사·총재·
   장관·대사·시장·의원·주석·총리 같은 **자리**를 Organization 으로 내지 마라.
   《전라도관찰사》《삼도수군통제사》《외무참의》는 조직이 아니다.
4. **인물 이름에 직함을 붙이지 마라.** "김대중 대통령" 이 아니라 "김대중",
   "김정일 국방위원장" 이 아니라 "김정일" 이다.
5. **한국사 밖은 뽑지 마라.** 조지 워싱턴·링컨·십자군 전쟁·프랑스처럼 한국사와
   무관한 인물·사건·국가는 노드가 아니다. 외국 국가(미국·일본·중국·소련)도
   Organization 이 아니다.
6. **문헌·건축물·제도는 Event 가 아니다.** 《선조수정실록》《독립문》《화성》은
   사건이 아니다.
6-1. **같은 from·to·kind 를 여러 번 내지 마라.** 근거 문장이 여럿이면 가장 잘
   받치는 것 하나만 고른다.
7. 지역(한양·만주·상하이)과 연도는 노드가 아니다.
8. 일반명사(독립·개혁·학교·정부)는 노드가 아니다. 고유한 이름만.
9. from·to 는 본문에 나온 **표기 그대로** 쓴다 (직함만 뗀다).
10. 관계가 없으면 빈 배열을 낸다. **억지로 채우지 마라.** 빈 배열이 틀린 엣지보다 낫다.

11. from·to 마다 노드 타입(Person·Organization·Event)을 같이 낸다. 관계마다 타입이
   정해져 있다 — 위 목록의 화살표 양쪽을 지켜라. 안 맞으면 그 엣지는 버려진다.

JSON 으로만 답한다:
{"edges":[{"from":"","fromType":"Person|Organization|Event","to":"","toType":"Person|Organization|Event","kind":"","quote":""}]}`;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Edge { from: string; fromType: string; to: string; toType: string; kind: string; quote: string }

/** 문단 경계에서 CHUNK 안팎으로 자른다. 문장 중간에서 끊으면 quote 가 깨진다. */
function chunk(text: string): string[] {
  const parts = text.split(/\n\n+/);
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (cur && cur.length + p.length > CHUNK) { out.push(cur); cur = ""; }
    cur += (cur ? "\n\n" : "") + p;
    while (cur.length > CHUNK * 1.6) { out.push(cur.slice(0, CHUNK)); cur = cur.slice(CHUNK); }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

let inTok = 0, outTok = 0, calls = 0, retries = 0;

async function ask(body: string): Promise<Edge[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY 가 없다 — .env.local 을 확인하라");
  for (let a = 0; a < 6; a++) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: MODEL, temperature: 0, response_format: { type: "json_object" },
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: body }],
        }),
      });
    } catch (e: any) {
      retries++; await sleep(Math.min(2 ** a * 1000, 30_000)); continue;
    }
    if (res.status === 429 || res.status >= 500) {
      retries++;
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(2 ** a * 1000, 30_000));
      continue;
    }
    if (!res.ok) {
      const t = (await res.text()).slice(0, 120).replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
      throw new Error(`HTTP ${res.status} — ${t}`);
    }
    const j: any = await res.json();
    calls++; inTok += j.usage?.prompt_tokens ?? 0; outTok += j.usage?.completion_tokens ?? 0;
    try {
      const parsed = JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
      return Array.isArray(parsed.edges) ? parsed.edges : [];
    } catch { return []; }
  }
  throw new Error("재시도 6회 실패");
}

async function main() {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const limit = Number(arg("--limit") ?? 0);
  const only = arg("--doc");

  // 이미 끝낸 조각은 건너뛴다
  const done = new Set<string>();
  const prev = await readFile(RAW, "utf-8").catch(() => "");
  for (const line of prev.split("\n")) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).id); } catch {}
  }
  if (done.size) console.log(`이어받기 — 조각 ${done.size}개 완료됨\n`);

  // 조각 목록
  const jobs: { id: string; title: string; era: string; text: string }[] = [];
  let files = (await readdir(join(OUT, "docs"))).filter((f) => f.endsWith(".md")).sort();
  for (const f of files) {
    const raw = await readFile(join(OUT, "docs", f), "utf-8");
    const title = raw.match(/^# (.+)$/m)?.[1] ?? f;
    const era = raw.match(/^시대: (.+)$/m)?.[1] ?? "";
    if (only && title !== only) continue;
    const body = raw.split(/\n\n/).slice(1).join("\n\n");
    chunk(body).forEach((text, i) => jobs.push({ id: `${title}#${i}`, title, era, text }));
    if (limit && new Set(jobs.map((j) => j.title)).size >= limit) break;
  }
  const todo = jobs.filter((j) => !done.has(j.id));
  console.log(`문서 ${new Set(jobs.map((j) => j.title)).size}건 · 조각 ${jobs.length}개 · 할 일 ${todo.length}개 · 모델 ${MODEL}\n`);

  let proposed = 0, kept = 0, badQuote = 0, badKind = 0, badType = 0, i = 0;
  const t0 = Date.now();

  async function worker() {
    while (true) {
      const j = todo[i++];
      if (!j) return;
      let edges: Edge[] = [];
      try { edges = await ask(`문서: 《${j.title}》\n\n${j.text}`); }
      catch (e) { console.log(`\n  ✗ ${j.id} — ${(e as Error).message}`); continue; }

      const hay = norm(j.text);
      const ok: Edge[] = [];
      for (const e of edges) {
        proposed++;
        if (!e?.from || !e?.to || !e?.quote) { badQuote++; continue; }
        const sig = SIGNATURE[e.kind];
        if (!sig) { badKind++; continue; }
        // **타입 서명 대조** — MENTORED 의 to 가 조직이면 여기서 걸린다
        if (!sig.from.includes(e.fromType) || !sig.to.includes(e.toType)) { badType++; continue; }
        // **원문 대조** — 지어낸 근거를 막는다
        if (!hay.includes(norm(e.quote))) { badQuote++; continue; }
        ok.push({
          from: String(e.from).trim(), fromType: e.fromType,
          to: String(e.to).trim(), toType: e.toType,
          kind: e.kind, quote: norm(e.quote),
        });
      }
      kept += ok.length;
      await appendFile(RAW, JSON.stringify({ id: j.id, doc: j.title, era: j.era, edges: ok }) + "\n");
      const pct = proposed ? Math.round(kept / proposed * 100) : 0;
      process.stdout.write(`\r  ${String(Math.min(i, todo.length)).padStart(4)}/${todo.length}  엣지 ${kept} (통과 ${pct}%)  ${j.title.slice(0, 16).padEnd(18)}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const cost = inTok / 1e6 * 0.4 + outTok / 1e6 * 1.6; // gpt-4.1-mini 기준 추정
  console.log(`\n\n호출 ${calls}회 (재시도 ${retries}) · ${Math.round((Date.now() - t0) / 1000)}초`);
  console.log(`토큰 입력 ${inTok.toLocaleString()} · 출력 ${outTok.toLocaleString()} · 추정 $${cost.toFixed(2)}`);
  console.log(`\n제안 ${proposed}개 → 채택 ${kept}개  (**quote 원문 대조 통과율 ${proposed ? Math.round(kept / proposed * 100) : 0}%**)`);
  console.log(`  버림: 근거 문장이 원문에 없음 ${badQuote}개 · 타입 서명 불일치 ${badType}개 · 스키마 밖 관계 ${badKind}개`);
  console.log(`→ ${RAW}`);
}

await main();
