/**
 * 영화 그래프 색인과 탐색.
 *
 * **이 파일에는 LLM 호출이 한 줄도 없다.** 탐색은 순수 함수라 픽스처만으로
 * 전부 검증할 수 있다 — law-navigator 에서 가장 값어치 있었던 설계다.
 *
 * 법령과 다른 점 하나: 노드가 **이종(異種)** 이다.
 * 법령은 조문 → 조문이었지만, 여기서는 영화 → 인물 → 영화로 **번갈아 간다.**
 * 그래서 홉 수를 셀 때 "인물을 지나는 것"을 한 홉으로 볼지가 문제가 되는데,
 * 사람이 느끼는 거리는 **영화에서 영화까지**이므로 영화 기준으로 센다.
 */

import type { Collection, Edge, EdgeKind, GraphData, Movie, Person, Route } from "./types.ts";

export interface Hop {
  from: string;
  to: string;
  kind: EdgeKind;
  /** 이 홉을 건넌 이유 — "마동석 (마동석 역)" 처럼 사람에게 보여 준다 */
  via?: string;
}

export interface Collected {
  movies: Movie[];
  /** 씨앗에서 각 영화까지의 경로 */
  paths: Map<string, Hop[]>;
  /** 예산 때문에 잘라낸 수 — 조용히 버리지 않고 보고한다 */
  dropped: number;
}

export class MovieGraph {
  readonly movies = new Map<string, Movie>();
  readonly people = new Map<string, Person>();
  readonly collections = new Map<string, Collection>();
  readonly genreIndex: Record<string, string[]>;
  private out = new Map<string, Edge[]>();
  private inc = new Map<string, Edge[]>();

  constructor(data: GraphData) {
    this.genreIndex = data.genreIndex ?? {};
    for (const m of data.movies) this.movies.set(m.id, m);
    for (const p of data.people) this.people.set(p.id, p);
    for (const c of data.collections ?? []) this.collections.set(c.id, c);
    for (const e of data.edges) {
      (this.out.get(e.from) ?? this.out.set(e.from, []).get(e.from)!).push(e);
      (this.inc.get(e.to) ?? this.inc.set(e.to, []).get(e.to)!).push(e);
    }
  }

  movie(id: string) { return this.movies.get(id); }
  person(id: string) { return this.people.get(id); }
  node(id: string) { return this.movies.get(id) ?? this.people.get(id); }

  outgoing(id: string, kind?: EdgeKind): Edge[] {
    const es = this.out.get(id) ?? [];
    return kind ? es.filter((e) => e.kind === kind) : es;
  }
  incoming(id: string, kind?: EdgeKind): Edge[] {
    const es = this.inc.get(id) ?? [];
    return kind ? es.filter((e) => e.kind === kind) : es;
  }
  degree(id: string) { return this.outgoing(id).length + this.incoming(id).length; }

  /** 이 영화에 참여한 사람들 (엣지가 인물 → 영화 방향이므로 들어오는 쪽) */
  creditsOf(id: string, kind?: EdgeKind): Edge[] { return this.incoming(id, kind); }
  /** 이 사람이 참여한 영화들 */
  filmsOf(id: string, kind?: EdgeKind): Edge[] { return this.outgoing(id, kind); }
}

// ── 예산 ────────────────────────────────────────────────────────────────
//
// law-navigator 의 교훈: 면제는 **관계가 아니라 (관계, 방향)** 에 붙어야 한다.
// 여기서도 같다. '출연'은 압도적으로 많아서 그냥 담으면 정작 필요한 한 편이 밀린다.

export interface Budget {
  maxMovies: number;
  /** (관계,방향)별 할당량 */
  perRelation: number;
  /** 영화 기준 홉 수 */
  maxHops: number;
  /** 다리로 쓸 인물을 몇 명까지 볼 것인가 — 주연급부터 */
  peoplePerMovie: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxMovies: 10,
  perRelation: 4,
  maxHops: 2,
  peoplePerMovie: 5,
};

export interface EvidencePlan {
  /** 이 경로에서 우대할 관계 */
  primary: EdgeKind[];
  /** 할당량을 면제할 관계 */
  exempt: EdgeKind[];
}

const BRIDGE: EvidencePlan = { primary: ["ACTED_IN", "DIRECTED"], exempt: ["DIRECTED"] };

export const ROUTE_PLAN: Record<Route, EvidencePlan> = {
  lookup: { primary: ["DIRECTED", "ACTED_IN"], exempt: ["DIRECTED"] },
  filmography: { primary: ["DIRECTED", "ACTED_IN"], exempt: ["DIRECTED", "ACTED_IN"] },
  bridge: BRIDGE,
  similar: { primary: ["ACTED_IN", "DIRECTED"], exempt: [] },
  award: { primary: ["ACTED_IN", "DIRECTED"], exempt: ["DIRECTED"] },
  out_of_scope: { primary: [], exempt: [] },
};

/**
 * 씨앗에서 출발해 근거 영화를 모은다.
 *
 * 영화 → (참여 인물) → 그 인물의 다른 영화. 인물은 **다리**일 뿐 근거가 아니므로
 * 결과에는 영화만 담고, 경로에만 인물이 남는다.
 */
export function collectEvidence(
  g: MovieGraph,
  seeds: string[],
  budget: Budget = DEFAULT_BUDGET,
  route: Route = "bridge",
): Collected {
  const plan = ROUTE_PLAN[route] ?? BRIDGE;
  const paths = new Map<string, Hop[]>();
  const order: string[] = [];
  let dropped = 0;

  for (const s of seeds) {
    if (g.movie(s) && !paths.has(s)) { paths.set(s, []); order.push(s); }
  }

  const quota = new Map<string, number>();
  const take = (kind: EdgeKind) => {
    if (plan.exempt.includes(kind)) return true;
    const used = quota.get(kind) ?? 0;
    if (used >= budget.perRelation) return false;
    quota.set(kind, used + 1);
    return true;
  };

  let frontier = [...order];
  for (let hop = 0; hop < budget.maxHops && order.length < budget.maxMovies; hop++) {
    const next: string[] = [];
    for (const mid of frontier) {
      // 이 영화에 참여한 사람 — 주연·감독부터
      const credits = g.creditsOf(mid)
        .filter((e) => plan.primary.includes(e.kind))
        .sort((a, b) => {
          const w = (e: Edge) => (e.kind === "DIRECTED" ? -1 : (e.order ?? 99));
          return w(a) - w(b);
        })
        .slice(0, budget.peoplePerMovie);

      for (const c of credits) {
        const person = g.person(c.from);
        if (!person) continue;
        for (const f of g.filmsOf(c.from).filter((e) => plan.primary.includes(e.kind))) {
          if (paths.has(f.to) || !g.movie(f.to)) continue;
          if (order.length >= budget.maxMovies) { dropped++; continue; }
          if (!take(f.kind)) { dropped++; continue; }
          paths.set(f.to, [
            ...(paths.get(mid) ?? []),
            { from: mid, to: f.to, kind: f.kind, via: person.name },
          ]);
          order.push(f.to);
          next.push(f.to);
        }
      }
    }
    if (!next.length) break;
    frontier = next;
  }

  return {
    movies: order.map((id) => g.movie(id)!).filter(Boolean),
    paths,
    dropped,
  };
}

/** 사람이 읽는 경로 한 줄 — "부산행 ─마동석─▶ 이터널스" */
export function describePath(g: MovieGraph, path: Hop[]): string {
  if (!path.length) return "";
  const label = (id: string) => g.movie(id)?.title ?? g.person(id)?.name ?? id;
  let s = label(path[0].from);
  for (const h of path) s += ` ─${h.via ?? ""}─▶ ${label(h.to)}`;
  return s;
}

/** 품질 점검 — 말뭉치가 한 덩어리로 이어져 있는가 */
export function healthCheck(g: MovieGraph) {
  const isolated = [...g.movies.keys()].filter((id) => g.degree(id) === 0);
  const bridges = [...g.people.keys()].filter((pid) => {
    const fs = g.filmsOf(pid).map((e) => g.movie(e.to)).filter(Boolean) as Movie[];
    return fs.some((f) => f.originalLanguage === "ko") && fs.some((f) => f.originalLanguage !== "ko");
  });
  return { isolated, bridgePeople: bridges.length };
}
