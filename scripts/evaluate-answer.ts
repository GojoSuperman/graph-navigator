/**
 * 답변 문장 채점 — evaluate.ts 가 **재지 않는 층**.
 *
 *   node --env-file-if-exists=.env.local scripts/evaluate-answer.ts
 *   pnpm eval:answer -- --split=holdout-100
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────────
 * evaluate.ts 는 컨텍스트 재현율만 잰다 — "정답에 필요한 근거를 데려왔는가".
 * 그런데 **근거가 완벽한데 답변 문장만 고장나는** 사고를 실제로 냈고,
 * 그때 숫자는 한 칸도 움직이지 않았다.
 *
 *   "황정민 배우가 나온 영화"    → 호프·곡성·서울의 봄 …   맞다
 *   "황정민이 출연한 영화"       → "확인되지 않습니다"      틀렸다
 *   "황정민이 주연으로 나온 영화" → "확인되지 않습니다"      틀렸다
 *
 * 근거 12편은 세 번 다 똑같았다. 재현율 104/107 도 똑같았다.
 * **재지 않은 것은 고장 나 있어도 드러나지 않는다** — 이 프로젝트에서 반복된 교훈이다.
 *
 * ── 무엇을 재는가 ────────────────────────────────────────────────────
 * 이 스크립트가 재는 것은 **근거에 답이 들어 있을 때 답변이 그것을 말하는가** 다.
 * 기준을 근거 블록(모델이 실제로 본 글자)에 대고 세운다 — 근거에 없는 것을
 * 못 말한 것은 이 층의 잘못이 아니다(그건 evaluate.ts 소관이다).
 *
 * 그래서 네 칸으로 가른다. 대각선 둘이 각각 다른 고장을 가리킨다:
 *
 *                  답변이 말함   답변이 못 말함
 *   근거에 답 있음      정상      ← **이 층의 손실** (황정민 사고가 여기)
 *   근거에 답 없음   ← 지어냄       근거 단계의 손실
 *
 * ── 비용 ─────────────────────────────────────────────────────────────
 * evaluate.ts 와 달리 LLM 을 부른다. 그래서 **캐시**를 둔다.
 * 키가 (모델 · 시스템 프롬프트 · 근거 블록) 이므로 검색·프롬프트가 바뀐
 * 문항만 다시 부른다. 아무것도 안 바뀌었으면 0원에 같은 숫자가 나온다.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MovieGraph } from "../lib/graph.ts";
import { ask, type AskResult } from "../lib/ask.ts";
import { generateAnswer, evidenceBlock, MODEL, SYSTEM } from "../lib/answer.ts";

const DATA = join(import.meta.dirname, "..", "data");
const CACHE_PATH = join(DATA, "answer-cache.json");

// ── 옵션 ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
};
const only = { split: opt("split"), kind: opt("kind"), id: opt("id") };
const limit = Number(opt("limit") ?? 0) || Infinity;
const refresh = opt("refresh") !== undefined;
const show = opt("show") !== undefined;
const concurrency = Math.max(1, Number(opt("concurrency") ?? 4) || 4);

if (opt("help") !== undefined) {
  console.log(`
  답변 문장 채점

    --split=holdout-100   묶음만
    --kind=character      유형만
    --id=h012             문항 하나만
    --limit=20            앞에서 N개만
    --refresh             캐시 무시하고 다시 부른다
    --show                맞은 것까지 답변 전문을 찍는다
    --concurrency=4       동시 호출 수
`);
  process.exit(0);
}

// ── 데이터 ──────────────────────────────────────────────────────────
const g = new MovieGraph(JSON.parse(await readFile(join(DATA, "graph.json"), "utf-8")));
const gold = JSON.parse(await readFile(join(DATA, "golden.json"), "utf-8"));

type Item = {
  id: string; kind: string; split: string; question: string; answer: string;
  needPerson?: string; needMovies?: string[]; claimTrue?: boolean; note?: string;
};

/**
 * 채점 기준이 없는 유형.
 *   ranking — 검색이 아니라 정렬이다. "가장 핫한 영화" 의 정답은 시점에 따라 바뀐다.
 * 정답을 못 적는 문항을 채점표에 넣으면 숫자가 거짓이 된다.
 */
const UNGRADED = new Set(["ranking"]);
/** 답하지 않는 것이 정답인 유형 — 따로 센다 */
const MUST_NOT_ANSWER = new Set(["out_of_scope", "no-answer"]);

const items: Item[] = gold.items
  .filter((it: Item) => !only.split || it.split === only.split)
  .filter((it: Item) => !only.kind || it.kind === only.kind)
  .filter((it: Item) => !only.id || it.id === only.id)
  .filter((it: Item) => !UNGRADED.has(it.kind))
  .slice(0, limit);

// ── 채점 기준 ────────────────────────────────────────────────────────

/** 글자만 남긴다 — 모델이 《》를 붙이거나 띄어쓰기를 달리해도 같은 답이다 */
const flat = (s: string) => s.replace(/[\s《》「」＜＞<>'"'']/g, "");
const says = (text: string, needle: string) =>
  needle.length > 0 && flat(text).includes(flat(needle));

/**
 * 이 문항의 답이라고 인정할 글자들.
 *
 * 유형마다 답의 **종류**가 다르다. 한 덩어리로 묶으면 채점이 거짓이 된다 —
 * 개봉 연도 질문에서 《기생충》만 말하고 연도를 안 말해도 맞았다고 세게 된다.
 */
function expectedOf(it: Item): string[] {
  const raw = (it.answer ?? "").trim();
  const clean = raw.replace(/[《》'']/g, "").trim();
  const usable = clean && !clean.startsWith("(") ? clean : "";

  /**
   * 개봉 연도·개봉일 — 답은 **숫자**다. 작품명을 말한 것은 답이 아니다.
   *
   * h090 은 kind 가 verify-claim 인데 실제로는 개봉일을 묻는다(needPerson 이 없다).
   * 유형만 보고 나누면 "《왕의 남자》입니다" 를 정답으로 세게 된다 — 날짜를
   * 한 글자도 말하지 않았는데. 재는 대상은 **유형표가 아니라 그 문항의 답**이다.
   */
  if (it.kind === "release" || (it.kind === "verify-claim" && !it.needPerson)) {
    const y = raw.match(/\d{4}/);
    return y ? [y[0]] : usable ? [usable] : [];
  }
  // 답이 **사람**인 유형
  if (it.kind === "character" || it.kind === "cast" || it.kind === "intersect-person") {
    return [...new Set([it.needPerson, usable].filter(Boolean) as string[])];
  }
  // 나머지는 답이 **작품**이다. 교집합 질문은 정답이 여럿이라 하나만 맞아도 된다.
  return [...new Set([...(it.needMovies ?? []), usable].filter(Boolean) as string[])];
}

/** 답을 못 하겠다고 말한 문장인가 */
const REFUSAL = /확인되지 않|근거에는? 없|근거에서 확인|알 수 없|정보가 없|나와 있지 않|찾을 수 없/;
/** 아니라고 말한 문장인가 — 참/거짓 판별 채점에 쓴다 */
const DENIAL = /아닙니다|아니다|아니에요|사실이 아|틀렸|맞지 않|출연하지 않|나오지 않|없습니다|없다/;

type Verdict = "맞음" | "틀림" | "제외";
interface Row {
  it: Item;
  text: string | null;
  reason: string;
  block: string;
  expected: string[];
  /** 모델이 실제로 본 근거 안에 답이 들어 있었는가 */
  inEvidence: boolean;
  verdict: Verdict;
  why: string;
  cached: boolean;
}

function grade(it: Item, res: { text: string | null; reason: string }, expected: string[]): { verdict: Verdict; why: string } {
  // ── 답하지 않는 것이 정답인 문항 ──────────────────────────────────
  if (MUST_NOT_ANSWER.has(it.kind)) {
    if (res.text === null) return { verdict: "맞음", why: res.reason };
    if (REFUSAL.test(res.text)) return { verdict: "맞음", why: "문장으로 거절" };
    return { verdict: "틀림", why: "답을 만들어 냈다" };
  }

  /**
   * 틀린 주장은 **전제 오류로 막히는 것이 정답**이다.
   *
   * "김혜수는 타짜·도둑들·암살에 모두 출연했다" 는 사실이 아니다. 코드 층이
   * checkPremise 로 막고 화면에 "전제가 사실이 아닙니다" 를 띄운다 — 그게 맞는 동작이다.
   * 처음엔 이것을 전부 '답변 없음 = 틀림' 으로 세어 6문항을 거짓으로 깎았다.
   * **채점 규칙이 틀리면 고칠 필요 없는 것을 고치게 된다.**
   */
  if (it.kind === "verify-claim" && it.claimTrue === false && res.text === null) {
    return { verdict: "맞음", why: `막음 — ${res.reason}` };
  }

  // ── 답해야 하는 문항이 아예 호출되지 않은 경우 ────────────────────
  // 황정민 사고가 정확히 여기다. 재현율에는 잡히지 않는다.
  if (res.text === null) return { verdict: "틀림", why: `답변 없음 — ${res.reason}` };

  // ── 참/거짓 판별 — 맞다/아니다의 방향을 본다 ──────────────────────
  // 글자 규칙이라 완전하지 않다. 그래서 틀린 것은 전문을 찍어 눈으로 본다.
  if (it.kind === "verify-claim" && typeof it.claimTrue === "boolean" && it.needPerson) {
    const denied = DENIAL.test(res.text);
    if (it.claimTrue && denied) return { verdict: "틀림", why: "맞는 주장을 아니라고 했다" };
    if (!it.claimTrue && !denied) return { verdict: "틀림", why: "틀린 주장을 맞다고 했다" };
    return { verdict: "맞음", why: it.claimTrue ? "맞다고 함" : "아니라고 함" };
  }

  if (!expected.length) return { verdict: "제외", why: "정답을 글자로 적을 수 없는 문항" };

  const hit = expected.find((e) => says(res.text!, e));
  if (hit) return { verdict: "맞음", why: hit };
  if (REFUSAL.test(res.text)) return { verdict: "틀림", why: "거절했다" };
  return { verdict: "틀림", why: "다른 것을 답했다" };
}

// ── 캐시 ────────────────────────────────────────────────────────────
type Cache = Record<string, { text: string | null; reason: string; model?: string; at: string }>;
let cache: Cache = {};
try { cache = JSON.parse(await readFile(CACHE_PATH, "utf-8")); } catch { /* 없으면 새로 만든다 */ }

const keyOf = (q: string, block: string) =>
  createHash("sha1").update([MODEL, SYSTEM, q, block].join("\u0000")).digest("hex").slice(0, 16);

// ── 실행 ────────────────────────────────────────────────────────────
const L = (s = "") => console.log(s);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : "—");

// 1단계 — LLM 없이 근거까지 조립한다 (여기까지는 비용 0)
const prepared = items.map((it) => {
  const r: AskResult = ask(g, it.question);
  const block = evidenceBlock(r);
  return { it, r, block, expected: expectedOf(it), key: keyOf(it.question, block) };
});

const needCall = prepared.filter((p) => !p.r.refused && !p.r.premiseBroken && p.block.trim() && (refresh || !cache[p.key]));
L();
L(`  문항 ${prepared.length}개 · 캐시에 있는 것 ${prepared.length - needCall.length}개 · 새로 부를 것 ${needCall.length}개 (${MODEL})`);
if (needCall.length && !process.env.OPENAI_API_KEY) {
  L(`  ⚠ OPENAI_API_KEY 가 없다. --env-file-if-exists=.env.local 로 돌리거나 키를 넣어라.`);
}

// 2단계 — 부른다. 동시 호출 수를 제한하고, 일시적 실패는 다시 시도한다.
let called = 0;
async function callWithRetry(r: AskResult, tries = 3): Promise<{ text: string | null; reason: string; model?: string }> {
  for (let i = 0; i < tries; i++) {
    const res = await generateAnswer(r);
    // 한도·일시 오류만 다시 시도한다. 코드 층이 막은 것은 다시 불러도 같다.
    if (res.text === null && /한도|HTTP 5|오류/.test(res.reason) && i < tries - 1) {
      await new Promise((ok) => setTimeout(ok, 1500 * (i + 1)));
      continue;
    }
    return res;
  }
  return { text: null, reason: "재시도 끝에 실패" };
}

const rows: Row[] = [];
const queue = [...prepared];
async function worker() {
  for (;;) {
    const p = queue.shift();
    if (!p) return;
    const cached = !refresh && Boolean(cache[p.key]);
    let res: { text: string | null; reason: string; model?: string };
    if (cached) {
      res = cache[p.key];
    } else {
      res = await callWithRetry(p.r);
      // 코드 층이 막은 것(근거 없음·전제 오류)은 캐시하지 않는다 — 부른 적이 없다
      if (!(p.r.refused || p.r.premiseBroken)) {
        cache[p.key] = { ...res, at: new Date().toISOString() };
        called++;
        if (called % 10 === 0) process.stderr.write(`    … ${called}/${needCall.length}\n`);
      }
    }
    const { verdict, why } = grade(p.it, res, p.expected);
    rows.push({
      it: p.it, text: res.text, reason: res.reason, block: p.block,
      expected: p.expected, inEvidence: p.expected.some((e) => says(p.block, e)),
      verdict, why, cached,
    });
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
rows.sort((a, b) => prepared.findIndex((p) => p.it.id === a.it.id) - prepared.findIndex((p) => p.it.id === b.it.id));
await writeFile(CACHE_PATH, JSON.stringify(cache, null, 1), "utf-8");

// ── 보고 ────────────────────────────────────────────────────────────
L();
L("═".repeat(78));
L("  답변 문장 채점 — 근거를 데려왔는가가 아니라, 그 근거로 답했는가");
L("═".repeat(78));

const answerable = rows.filter((r) => !MUST_NOT_ANSWER.has(r.it.kind) && r.verdict !== "제외");
const ok = answerable.filter((r) => r.verdict === "맞음").length;
L(`\n  [ 전체 ] ${ok}/${answerable.length} (${pct(ok, answerable.length)})`);

L("\n  [ 유형별 ]");
for (const kind of [...new Set(answerable.map((r) => r.it.kind))]) {
  const s = answerable.filter((r) => r.it.kind === kind);
  const k = s.filter((r) => r.verdict === "맞음").length;
  L(`    ${kind.padEnd(16)} ${String(k).padStart(3)}/${String(s.length).padEnd(3)} (${pct(k, s.length).padStart(4)})`);
}

L("\n  [ 묶음별 ]");
for (const sp of [...new Set(answerable.map((r) => r.it.split))]) {
  const s = answerable.filter((r) => r.it.split === sp);
  const k = s.filter((r) => r.verdict === "맞음").length;
  L(`    ${sp.padEnd(16)} ${String(k).padStart(3)}/${String(s.length).padEnd(3)} (${pct(k, s.length).padStart(4)})`);
}

// ── 네 칸 ───────────────────────────────────────────────────────────
//
// 이 표가 이 스크립트의 존재 이유다. 재현율은 왼쪽 열만 본다.
const g1 = answerable.filter((r) => r.inEvidence && r.verdict === "맞음");
const g2 = answerable.filter((r) => r.inEvidence && r.verdict === "틀림");
const g3 = answerable.filter((r) => !r.inEvidence && r.verdict === "맞음");
const g4 = answerable.filter((r) => !r.inEvidence && r.verdict === "틀림");
L("\n  [ 근거에 답이 있었는가 × 답변이 그것을 말했는가 ]");
L("                      답변 맞음   답변 틀림");
L(`    근거에 답 있음      ${String(g1.length).padStart(7)}   ${String(g2.length).padStart(7)}   ← 오른쪽이 **이 층의 손실**`);
L(`    근거에 답 없음      ${String(g3.length).padStart(7)}   ${String(g4.length).padStart(7)}   ← 왼쪽은 모델이 제 지식으로 답한 것`);
L(`\n    근거가 답을 담고 있을 때의 답변 정확도 — ${g1.length}/${g1.length + g2.length} (${pct(g1.length, g1.length + g2.length)})`);

if (g2.length) {
  L("\n  [ 근거에 답이 있는데 답변이 못 말한 것 — 고칠 자리 ]");
  for (const r of g2) {
    L(`\n    [${r.it.id}] ${r.it.question.slice(0, 54)}`);
    L(`      기대  ${r.expected.join(" / ")}          (${r.why})`);
    L(`      답변  ${(r.text ?? `— ${r.reason}`).replace(/\s+/g, " ").slice(0, 110)}`);
  }
}
if (g3.length) {
  L("\n  [ 근거에 없는 답을 말했다 — 지어냈는지 확인이 필요하다 ]");
  for (const r of g3) L(`    [${r.it.id}] ${r.it.question.slice(0, 44)}  → ${r.why}`);
}

// ── 답하지 않는 것이 정답인 문항 ─────────────────────────────────────
const mustNot = rows.filter((r) => MUST_NOT_ANSWER.has(r.it.kind));
if (mustNot.length) {
  L("\n  [ 답하지 않는 것이 정답인 문항 ]");
  for (const r of mustNot) {
    L(`    ${r.verdict === "맞음" ? "✅" : "❌"} ${r.it.id.padEnd(7)} ${r.it.question.slice(0, 36).padEnd(38)} ${r.why.slice(0, 30)}`);
  }
  L(`    ${mustNot.filter((r) => r.verdict === "맞음").length}/${mustNot.length}`);
}

const skipped = rows.filter((r) => r.verdict === "제외");
if (skipped.length) L(`\n  [ 제외 ] ${skipped.length}문항 — 정답을 글자로 적을 수 없다`);

if (show) {
  L("\n  [ 전문 ]");
  for (const r of rows) {
    L(`\n    ${r.verdict === "맞음" ? "✅" : r.verdict === "틀림" ? "❌" : "·"} [${r.it.id}] ${r.it.question}`);
    L(`      ${(r.text ?? `— ${r.reason}`).replace(/\s+/g, " ")}`);
  }
}

/**
 * 근거 크기도 같이 보고한다.
 * 근거에 무엇을 더 싣는 결정은 **정확도와 토큰의 교환**이라, 한쪽만 보면 판단할 수 없다.
 * 크레딧 줄이 차지하는 몫을 따로 떼어 보여 준다.
 */
const sizes = rows.map((r) => r.block.length);
const creditChars = rows.reduce(
  (sum, r) => sum + r.block.split("\n").filter((l) => /^ {4}(감독|각본|출연) /.test(l)).reduce((a, l) => a + l.length + 1, 0),
  0,
);
const avg = sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0;
L(`\n  [ 근거 크기 ] 평균 ${avg}자 · 최대 ${Math.max(0, ...sizes)}자 · 그중 크레딧 줄이 ${Math.round((creditChars / Math.max(1, sizes.reduce((a, b) => a + b, 0))) * 100)}%`);

L(`\n  새로 호출 ${called}회 · 캐시 적중 ${rows.filter((r) => r.cached).length}회 · 캐시 ${CACHE_PATH.replace(/.*\//, "data/")}`);
L("═".repeat(78));
L();
