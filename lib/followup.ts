/**
 * 이어지는 질문 — "그중에 상 받은 건?"
 *
 * ── 왜 규칙으로 하나 ────────────────────────────────────────────────
 * LLM 에게 이전 대화를 넘겨 다시 검색하게 할 수도 있다. 하지만 그러면
 * **검색 경로에 LLM 이 들어가** 이 프로젝트의 성질이 깨진다 —
 * 무엇을 근거로 데려왔는지를 모델 없이 검증할 수 없게 되고, 평가 비용도 0 이 아니게 된다.
 *
 * 그래서 "그중에" 는 **새로 찾지 않는다.** 직전 근거를 그대로 물려받아 거른다.
 * 거를 수 없는 질문이면 이어짐을 포기하고 새 질문으로 처리한다 —
 * 억지로 이으면 엉뚱한 답이 나오고, 사용자는 왜 그런지 알 수 없다.
 */

import type { Movie } from "./types.ts";

/** 직전 결과를 가리키는 말 */
const REFERS_BACK = [
  "그중", "그 중", "이중", "이 중", "거기서", "그것들", "그 영화들", "그 작품들",
  "방금", "위에서", "앞에서", "그 목록", "저 중", "그 가운데",
];

export interface Filter {
  /** 사람이 읽는 설명 — 화면에 "무엇을 걸렀는지" 보여 준다 */
  label: string;
  apply: (ms: Movie[]) => Movie[];
}

const byYearDesc = (a: Movie, b: Movie) => (b.year ?? 0) - (a.year ?? 0);

/** 질문에서 거르는 조건을 뽑는다. 하나도 못 뽑으면 이어짐을 포기한다. */
export function parseFilters(question: string): Filter[] {
  const q = question.replace(/\s+/g, "");
  const out: Filter[] = [];

  if (/상받|상을받|수상|상탄|상은/.test(q)) {
    out.push({ label: "수상작만", apply: (ms) => ms.filter((m) => (m.awards?.length ?? 0) > 0) });
  }
  if (/한국(영화)?(만|는|인)?/.test(q) && !/외국|해외/.test(q)) {
    out.push({ label: "한국 작품만", apply: (ms) => ms.filter((m) => m.originalLanguage === "ko") });
  }
  if (/외국|해외/.test(q)) {
    out.push({ label: "해외 작품만", apply: (ms) => ms.filter((m) => m.originalLanguage !== "ko") });
  }
  if (/최근|최신|요즘|나중/.test(q)) {
    out.push({ label: "최근 순", apply: (ms) => [...ms].sort(byYearDesc) });
  }
  if (/오래된|예전|옛날|처음/.test(q)) {
    out.push({ label: "오래된 순", apply: (ms) => [...ms].sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999)) });
  }
  if (/평점|별점|높은|잘만든|좋은/.test(q)) {
    out.push({ label: "평점 높은 순", apply: (ms) => [...ms].sort((a, b) => b.voteAverage - a.voteAverage) });
  }
  // 장르 이름이 그대로 들어 있으면 그 장르만
  for (const g of ["액션", "코미디", "드라마", "스릴러", "공포", "범죄", "로맨스", "SF", "애니메이션", "다큐멘터리", "판타지", "미스터리", "전쟁", "역사", "음악", "가족", "모험"]) {
    if (q.includes(g.replace(/\s+/g, ""))) {
      out.push({ label: `${g} 장르만`, apply: (ms) => ms.filter((m) => m.genres.includes(g)) });
    }
  }
  return out;
}

export interface FollowUp {
  /** 이어지는 질문인가 */
  isFollowUp: boolean;
  filters: Filter[];
  /** 왜 이어붙이지 못했는지 (이어짐을 포기한 경우) */
  gaveUp: string | null;
}

export function detectFollowUp(question: string, hasPrevious: boolean): FollowUp {
  const q = question.replace(/\s+/g, "");
  const refers = REFERS_BACK.some((w) => q.includes(w.replace(/\s+/g, "")));
  if (!refers) return { isFollowUp: false, filters: [], gaveUp: null };
  if (!hasPrevious) {
    return { isFollowUp: false, filters: [], gaveUp: "앞선 질문이 없어 '그중에' 가 무엇을 가리키는지 알 수 없습니다" };
  }
  const filters = parseFilters(question);
  if (!filters.length) {
    return { isFollowUp: false, filters: [], gaveUp: "직전 결과에서 무엇을 걸러야 할지 알아내지 못해, 새 질문으로 찾았습니다" };
  }
  return { isFollowUp: true, filters, gaveUp: null };
}
