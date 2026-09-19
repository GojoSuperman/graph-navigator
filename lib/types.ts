/**
 * 영화 그래프의 타입 정의.
 *
 * 법령 프로젝트에서 그대로 가져온 원칙:
 *   ① 이름이 같아도 종류가 다르면 다른 노드다 (영화 《괴물》 ≠ 장르 '괴물')
 *   ② 관계에 origin 을 남긴다 — 어디서 온 엣지인지 역추적할 수 있어야 한다
 *   ③ 탐색은 순수 함수로 — LLM 없이 검증 가능해야 한다
 */

/** 노드 ID 는 `${kind}:${tmdbId}` — 영화와 인물의 ID 가 겹치므로 접두사가 필요하다 */
export type NodeKind = "movie" | "person" | "collection";

export const movieId = (id: number) => `movie:${id}`;
export const personId = (id: number) => `person:${id}`;
export const collectionId = (id: number) => `collection:${id}`;

export interface Movie {
  id: string;
  tmdbId: number;
  title: string;
  /** 원제 — 한국어 제목이 없을 때 폴백이자, 검색 어휘를 넓혀 준다 */
  originalTitle: string;
  year: number | null;
  overview: string;
  genres: string[];
  /** 제작 국가 코드 (KR, US …) */
  countries: string[];
  originalLanguage: string;
  popularity: number;
  voteAverage: number;
  voteCount: number;
  /** 포스터 경로. 앞에 https://image.tmdb.org/t/p/w342 를 붙여 쓴다 */
  posterPath: string | null;
  /** 시리즈(컬렉션) 소속 — 《범죄도시》 같은 것 */
  collection: number | null;
  /**
   * 수상 기록. TMDB 에는 없어서 위키데이터에서 따로 받는다.
   * 결합은 제목이 아니라 **TMDB ID(P4947)** 로 한다 — 《괴물》 같은 동명이작에서
   * 제목 대조는 조용히 틀린다.
   */
  awards?: { award: string; year: number | null }[];
}

export interface Person {
  id: string;
  tmdbId: number;
  name: string;
  originalName: string;
  /** 주 분야 — Acting / Directing … */
  department: string;
  popularity: number;
  /**
   * 다른 이름. TMDB 는 인물을 **활동명**으로 저장한다 — 아이유는 `IU` 다.
   * 배역명의 로마자 문제와 달리 변환 규칙으로 풀 수 없어서,
   * TMDB 의 also_known_as 에서 한글 별칭만 골라 받아 둔다.
   */
  aliases?: string[];
  /**
   * 이 사람이 받은 상. **영화가 받은 상과 다르다** —
   * 《밀양》의 수상 기록에는 "칸 여우주연상" 이 없다. 그건 전도연이 받은 상이다.
   * 수상 자격에 작품이 달려 있어 forTmdb 로 우리 그래프와 이어진다.
   */
  awards?: { award: string; year: number | null; forTmdb: string | null; forTitle: string | null }[];
}

export interface Collection {
  id: string;
  tmdbId: number;
  name: string;
}

/**
 * 관계.
 *
 * 법령의 DELEGATES_TO 가 "건너야만 닿는 다리" 였던 것처럼,
 * 여기서는 ACTED_IN / DIRECTED 가 그 역할을 한다.
 * 《이터널스》 문서에 '부산행' 은 한 글자도 없지만,
 * 마동석을 거치면 두 편이 이어진다.
 */
export type EdgeKind =
  | "ACTED_IN"      // 인물 → 영화 (출연)
  | "DIRECTED"      // 인물 → 영화 (연출)
  | "WROTE"         // 인물 → 영화 (각본)
  | "PART_OF";      // 영화 → 컬렉션 (시리즈)

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** api = TMDB 크레딧에서 그대로 온 것 (환각 없음) */
  origin: "api";
  /** 배역명 — 근거를 사람에게 보여줄 때 쓴다 */
  as?: string;
  /** 출연 순서. 낮을수록 주연 — 예산 배분에 쓴다 */
  order?: number;
}

/**
 * 질문이 어느 경로로 처리되는가.
 *
 * 법령의 4갈래(local·delegation·penalty·global)를 영화에 맞게 옮긴 것이다.
 * bridge 가 delegation 의 자리 — **여러 홉을 건너야만 답이 되는 질문**이고,
 * 이 프로젝트가 증명하려는 것이 바로 여기다.
 */
export type Route =
  | "lookup"        // 특정 작품/인물의 정보 — 1홉
  | "filmography"   // 인물 → 작품 목록
  | "bridge"        // ★ 작품 → 인물 → 다른 작품 (2홉 이상)
  | "similar"       // 장르·시리즈 기반 추천
  | "award"         // 수상 — 근거가 줄거리가 아니라 수상 기록이다
  | "cast"          // 이 작품에 누가 나오나 — 답이 **사람 목록**이다
  | "out_of_scope"; // 예매·스트리밍·평점 예측 등 — 답하지 않는다

export interface GraphData {
  movies: Movie[];
  people: Person[];
  collections: Collection[];
  edges: Edge[];
  /** 장르명 → 그 장르의 대표 영화들. 법령의 '정의 용어 색인' 과 같은 자리 */
  genreIndex?: Record<string, string[]>;
}
