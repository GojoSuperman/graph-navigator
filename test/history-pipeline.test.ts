/**
 * 한국사 탐색과 공통 파이프라인.
 *
 * 여기서 지키는 것은 셋이다 —
 *   ① **탄 경로가 기록되는가.** 루브릭 2가 "실제로 탄 경로를 기록해 제시하는가" 를
 *      묻는다. 경로가 비면 답이 맞아도 증명이 안 된다.
 *   ② **허브를 경유하지 않는가.** 경유를 허용하면 근현대 인물 전원이 2홉 이웃이
 *      되어 멀티홉이 지름길로 바뀐다. 다만 **목적지로는 허용**해야 한다.
 *   ③ **근거가 없으면 거절하는가.** 그리고 어디서 끊겼는지가 `trace` 에 남는가.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HistoryGraph, collect, describePath, type GraphEdge, type GraphNode } from "../lib/history/graph.ts";
import { build } from "../lib/pipeline.ts";
import { historyDomain } from "../lib/domains/history.ts";

const n = (id: string, degree = 1, type: GraphNode["type"] = "Person"): GraphNode =>
  ({ id, type, era: "구한말·일제", aliases: [], degree });
const e = (from: string, kind: GraphEdge["kind"], to: string): GraphEdge =>
  ({ from, to, kind, quotes: [`${from}가 ${to}를 ...`], docs: [from] });

/**
 *   안창호 ─설립─▶ 신민회 ◀─소속─ 이승훈 ─참여─▶ 105인 사건
 *   허브(차수를 크게 준다) ← 모두가 붙는다
 */
const fixture = () => new HistoryGraph({
  nodes: [
    n("안창호", 2), n("신민회", 3, "Organization"), n("이승훈", 3),
    n("105인 사건", 2, "Event"), n("허브", 99), n("먼곳", 1),
  ],
  edges: [
    e("안창호", "FOUNDED", "신민회"),
    e("이승훈", "MEMBER_OF", "신민회"),
    e("이승훈", "PARTICIPATED_IN", "105인 사건"),
    e("안창호", "MEMBER_OF", "허브"),
    e("허브", "LED", "먼곳"),          // 허브를 **지나야만** 닿는 곳
  ],
}, 1); // 차수 상위 1개(=허브)를 통과 금지로

describe("collect — n홉 탐색과 경로 기록", () => {
  test("씨앗은 빈 경로, 이웃은 한 홉이 기록된다", () => {
    const got = collect(fixture(), ["안창호"], { maxHops: 1, maxNodes: 40, perKind: 12 });
    assert.deepEqual(got.paths.get("안창호"), []);
    const p = got.paths.get("신민회")!;
    assert.equal(p.length, 1);
    assert.deepEqual(p[0], { from: "안창호", to: "신민회", kind: "FOUNDED", dir: "out" });
  });

  test("2홉이면 다리를 건넌 경로가 통째로 남는다", () => {
    const got = collect(fixture(), ["안창호"], { maxHops: 2, maxNodes: 40, perKind: 12 });
    const p = got.paths.get("이승훈")!;
    assert.equal(p.length, 2, "안창호 → 신민회 → 이승훈");
    assert.equal(p[0].to, "신민회");
    assert.equal(p[1].to, "이승훈");
    // 관계를 **거꾸로** 타야 닿는다 — 이승훈 ─소속─▶ 신민회 를 역방향으로
    assert.equal(p[1].dir, "in");
  });

  test("허브는 목적지로는 되지만 **경유는 막힌다**", () => {
    const got = collect(fixture(), ["안창호"], { maxHops: 3, maxNodes: 40, perKind: 12 });
    assert.ok(got.nodes.includes("허브"), "목적지로는 들어와야 한다");
    assert.ok(!got.nodes.includes("먼곳"), "허브를 지나야만 닿는 곳은 막혀야 한다");
    assert.ok(got.blocked > 0, "막은 횟수를 센다");
  });

  test("예산을 넘으면 버리고, 버린 수를 센다", () => {
    const got = collect(fixture(), ["안창호"], { maxHops: 3, maxNodes: 2, perKind: 12 });
    assert.equal(got.nodes.length, 2);
    assert.ok(got.dropped > 0, "숨기지 않고 센다");
  });

  test("describePath 는 방향을 화살표로 보인다", () => {
    const got = collect(fixture(), ["안창호"], { maxHops: 2, maxNodes: 40, perKind: 12 });
    const s = describePath(got.paths.get("이승훈")!);
    assert.match(s, /안창호 ─설립─▶ 신민회 ─소속◀─ 이승훈/);
  });
});

describe("파이프라인 — 노드 흐름과 거절", () => {
  const app = () => build(historyDomain(fixture()));

  test("답할 수 있으면 assemble·answer 까지 간다", async () => {
    const s: any = await app().invoke({ question: "안창호가 세운 조직은?" });
    assert.equal(s.refused, false);
    assert.deepEqual(s.trace, ["followup", "route", "seeds", "expand", "assemble", "answer"]);
    assert.deepEqual(s.seedIds, ["안창호"]);
    assert.ok(s.triples.length > 0, "삼중항이 있어야 한다");
    assert.ok(s.path.length > 0, "**탄 경로가 비면 안 된다**");
  });

  test("두 개체가 걸리면 bridge 로 라우팅된다", async () => {
    const s: any = await app().invoke({ question: "안창호와 이승훈이 함께 속한 곳은?" });
    assert.equal(s.routeKind, "bridge");
    assert.equal(s.seedIds.length, 2);
  });

  test("범위 밖이면 route 에서 끊고 거절한다", async () => {
    const s: any = await app().invoke({ question: "오늘 서울 날씨 어때?" });
    assert.equal(s.refused, true);
    // **어디서 끊겼는지가 남아야 한다** — §7 의 실패 3층 분류가 이걸 쓴다
    assert.deepEqual(s.trace, ["followup", "route", "refuse"]);
    assert.equal(s.evidence.length, 0, "거절이면 아무것도 모으지 않는다");
  });

  test("그래프에 없는 개체면 근거를 지어내지 않는다", async () => {
    const s: any = await app().invoke({ question: "세종대왕이 만든 것은?" });
    assert.equal(s.refused, true);
    assert.ok(s.refusalReason);
  });
});
