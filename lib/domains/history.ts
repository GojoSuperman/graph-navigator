/**
 * 한국사 도메인 — 공통 `StateGraph` 의 노드 구현 (설계서 §6).
 *
 * 그래프 모양은 `lib/pipeline.ts` 가 정한다. 여기는 **각 노드가 무슨 일을 하는지**만
 * 채운다. 영화 도메인이 같은 자리에 다른 구현을 넣는다.
 *
 * **LLM 은 `answer` 한 곳에만 있다.** 나머지는 순수 함수라 평가가 비용 0으로 돈다.
 */

import { BM25 } from "../bm25.ts";
import { KIND_LABEL, type EdgeKind } from "../history/config.ts";
import { HistoryGraph, collect, describePath, type Hop } from "../history/graph.ts";
import type { Ask, Domain, EvidenceItem, Triple } from "../pipeline.ts";

/** 표기 흔들림을 턴 비교 키 — "3·1 운동" 과 "3.1운동" 은 같다 */
const key = (s: string) => s.replace(/[·・.\s]/g, "").toLowerCase();

/** 이 도메인의 질문인지 — 그래프의 이름이 하나도 안 걸리면 범위 밖이다 */
const OFF_DOMAIN = /(주가|날씨|환율|맛집|영화|배우|감독|출연|박스오피스|코딩|레시피)/;

export function historyDomain(g: HistoryGraph, opts: {
  answer?: (s: Ask) => Promise<string | null>;
  record?: (name: string, s: Ask) => void;
  /** 6단계 스윕이 값을 바꿔 가며 재려면 주입할 수 있어야 한다 */
  budget?: { maxHops: number; maxNodes: number; perKind: number };
} = {}): Domain {
  // 이름 → 노드 id. 별칭도 같이 건다
  const byKey = new Map<string, string>();
  for (const n of g.nodes.values()) {
    byKey.set(key(n.id), n.id);
    for (const a of n.aliases) if (!byKey.has(key(a))) byKey.set(key(a), n.id);
  }
  // 씨앗을 못 찾았을 때만 쓰는 최후 수단
  const bm = new BM25([...g.nodes.values()].map((n) => ({
    id: n.id,
    title: [n.id, ...n.aliases].join(" "),
    text: [n.type, n.era ?? ""].join(" "),
  })));

  /** 질문에 통째로 들어 있는 노드 이름들. **긴 이름부터** 본다 (부분 겹침 방지) */
  const mentioned = (q: string): string[] => {
    const hay = key(q);
    const hit: string[] = [];
    for (const [k, id] of [...byKey].sort((a, b) => b[0].length - a[0].length)) {
      if (k.length < 2 || hit.includes(id)) continue;
      if (hay.includes(k)) hit.push(id);
    }
    return hit;
  };

  return {
    name: "history",

    // ── route ──────────────────────────────────────────────────────────
    route: (s) => {
      if (OFF_DOMAIN.test(s.question)) {
        return { routeKind: "out_of_scope", reason: "한국사 그래프가 다루지 않는 주제입니다", refusalReason: "한국사 그래프가 다루지 않는 주제입니다" };
      }
      const hits = mentioned(s.question);
      if (!hits.length) {
        return { routeKind: "out_of_scope", reason: "질문에서 그래프의 개체를 찾지 못했습니다", refusalReason: "질문에 나온 인물·조직·사건을 그래프에서 찾지 못했습니다" };
      }
      // 두 개 이상 걸리면 **다리 질문** — 사이를 이어야 한다
      return { routeKind: hits.length >= 2 ? "bridge" : "lookup", reason: `개체 ${hits.length}개를 찾았습니다 — ${hits.join(" · ")}` };
    },

    // ── seeds ──────────────────────────────────────────────────────────
    //  제목·별칭 대조 → 그래도 없으면 BM25. **앞이 실패해야 뒤로 간다**
    seeds: (s) => {
      const hit = mentioned(s.question);
      if (hit.length) return { seedIds: hit.slice(0, 4) };
      const fallback = bm.search(s.question, 3).map((r) => r.id);
      return { seedIds: fallback, reason: fallback.length ? "이름으로 못 찾아 BM25 로 찾았습니다" : s.reason };
    },

    // ── expand ─────────────────────────────────────────────────────────
    expand: (s) => {
      const got = collect(g, s.seedIds, opts.budget);
      const seedSet = new Set(s.seedIds);
      const evidence: EvidenceItem[] = got.nodes.map((id) => {
        const n = g.node(id)!;
        return {
          id, type: n.type, era: n.era,
          path: got.paths.get(id) ?? [],
          isSeed: seedSet.has(id),
        };
      });
      // State 의 `path` 는 **씨앗이 아닌 것들이 실제로 탄 홉 전부**다
      const path = evidence.flatMap((e) => e.path);
      return { evidence, path, dropped: got.dropped, blocked: got.blocked };
    },

    // ── assemble ───────────────────────────────────────────────────────
    //  삼중항 + 근거 문장 + 출처 문서. **답변은 이것만 가지고 만든다**
    assemble: (s) => {
      const inSet = new Set(s.evidence.map((e) => e.id));
      // 노드마다 씨앗에서 몇 홉인가 — 삼중항 정렬에 쓴다
      const hopOf = new Map(s.evidence.map((e) => [e.id, e.path.length]));
      const triples: Triple[] = g.edges
        .filter((e) => inSet.has(e.from) && inSet.has(e.to))
        .map((e) => ({ from: e.from, kind: e.kind, to: e.to, quotes: e.quotes, docs: e.docs }))
        // **씨앗에 가까운 것부터.** 정렬을 안 뒀더니 "안창호가 세운 조직은?" 의 근거
        // 상위가 전부 김구였다 — 그래프에 담긴 순서대로 나왔기 때문이다.
        .sort((a, b) =>
          (Math.min(hopOf.get(a.from) ?? 9, hopOf.get(a.to) ?? 9))
          - (Math.min(hopOf.get(b.from) ?? 9, hopOf.get(b.to) ?? 9))
          || b.quotes.length - a.quotes.length);   // 여러 문서가 말한 사실을 먼저
      const sources = [...new Set(triples.flatMap((t) => t.docs))];
      return { triples, sources };
    },

    // ── answer ─────────────────────────────────────────────────────────
    //  **LLM 이 있는 유일한 자리.** 없으면 근거만 보여 준다 (키 없이도 데모가 돈다)
    answer: async (s) => {
      if (!opts.answer) return { answerText: null };
      return { answerText: await opts.answer(s) };
    },

    record: opts.record,
  };
}

/** 근거를 사람이 읽는 블록으로 — 화면과 LLM 프롬프트가 같은 것을 본다 */
export function evidenceBlock(s: Ask, limit = 30): string {
  const lines: string[] = [];
  for (const t of s.triples.slice(0, limit)) {
    lines.push(`(${t.from}) ─${KIND_LABEL[t.kind as EdgeKind] ?? t.kind}─▶ (${t.to})`);
    if (t.quotes[0]) lines.push(`    근거: "${t.quotes[0]}"`);
    if (t.docs[0]) lines.push(`    출처: 위키백과 《${t.docs[0]}》`);
  }
  return lines.join("\n");
}

/** 탄 경로들을 사람이 읽는 줄로 — 씨앗이 아닌 노드마다 한 줄 */
export function pathLines(s: Ask, limit = 12): string[] {
  return s.evidence
    .filter((e) => e.path.length)
    .slice(0, limit)
    .map((e) => describePath(e.path as Hop[]));
}
