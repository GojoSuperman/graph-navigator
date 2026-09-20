/**
 * 그래프 색인과 탐색 — 이 프로젝트가 증명하려는 것이 전부 여기서 만들어진다.
 *
 * 《이터널스》 문서에 '부산행' 은 한 글자도 없다. 마동석을 거쳐야만 닿는다.
 * 그 "거쳐 간다" 를 만드는 것이 collectEvidence 이고, **예산**이 그것을 제어한다.
 *
 * 예산은 조용히 틀린다 — 한도를 넘긴 것을 버리면서 아무 말도 하지 않으면
 * 근거가 부족한 것인지 관계가 없는 것인지 구분할 수 없게 된다. 그래서 여기서
 * 재는 것은 "무엇을 데려왔는가" 만이 아니라 **"몇 개를 버렸다고 말하는가"** 다.
 *
 * 픽스처만으로 전부 검증된다 — LLM 이 한 줄도 없기 때문이다.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MovieGraph, collectEvidence, describePath, healthCheck, DEFAULT_BUDGET } from "../lib/graph.ts";
import type { Edge, GraphData, Movie, Person } from "../lib/types.ts";

const mv = (id: string, lang = "ko"): Movie => ({
  id: `movie:${id}`, tmdbId: 0, title: id, originalTitle: id, year: 2020, overview: "",
  genres: [], countries: [], originalLanguage: lang, popularity: 0,
  voteAverage: 0, voteCount: 0, posterPath: null, collection: null,
});
const pr = (id: string): Person => ({
  id: `person:${id}`, tmdbId: 0, name: id, originalName: id, department: "Acting", popularity: 0,
});
const acted = (p: string, m: string, order: number, as?: string): Edge =>
  ({ from: `person:${p}`, to: `movie:${m}`, kind: "ACTED_IN", origin: "api", order, as });
const directed = (p: string, m: string): Edge =>
  ({ from: `person:${p}`, to: `movie:${m}`, kind: "DIRECTED", origin: "api" });

/**
 *   기생충 ─최우식─▶ 부산행 ─마동석─▶ 이터널스(en)
 *      └─이선균─▶ 끝까지간다
 *   외딴영화 — 아무와도 안 이어져 있다
 */
const DATA: GraphData = {
  movies: [mv("기생충"), mv("부산행"), mv("이터널스", "en"), mv("끝까지간다"), mv("외딴영화")],
  people: [pr("송강호"), pr("최우식"), pr("이선균"), pr("마동석"), pr("봉준호")],
  collections: [],
  edges: [
    directed("봉준호", "기생충"),
    acted("송강호", "기생충", 0, "Kim Ki-taek"),
    acted("최우식", "기생충", 1, "Kim Ki-woo"),
    acted("이선균", "기생충", 2, "Park Dong-ik"),
    acted("최우식", "부산행", 3),
    acted("마동석", "부산행", 0, "Sang-hwa"),
    acted("마동석", "이터널스", 0, "Gilgamesh"),
    acted("이선균", "끝까지간다", 0),
  ],
};
const g = new MovieGraph(DATA);
const titles = (ms: Movie[]) => ms.map((m) => m.title);

describe("MovieGraph — 색인", () => {
  test("영화와 인물은 ID 접두사로 갈린다 (둘 다 TMDB 번호를 쓰므로)", () => {
    assert.equal(g.movie("movie:기생충")?.title, "기생충");
    assert.equal(g.person("person:송강호")?.name, "송강호");
    assert.equal(g.movie("person:송강호"), undefined);
    assert.equal(g.node("person:송강호")?.id, "person:송강호");
  });

  test("creditsOf 는 작품에 참여한 사람, filmsOf 는 사람이 참여한 작품", () => {
    // 엣지는 인물 → 영화 한 방향뿐이라, 작품 쪽은 들어오는 엣지를 본다
    assert.equal(g.creditsOf("movie:기생충").length, 4);
    assert.equal(g.creditsOf("movie:기생충", "DIRECTED").length, 1);
    assert.equal(g.creditsOf("movie:기생충", "ACTED_IN").length, 3);
    assert.deepEqual(
      g.filmsOf("person:마동석").map((e) => e.to).sort(),
      ["movie:부산행", "movie:이터널스"],
    );
  });

  test("배역명은 엣지에 붙어 있다 — 근거를 사람에게 보여 줄 때 쓴다", () => {
    const e = g.creditsOf("movie:기생충", "ACTED_IN").find((x) => x.from === "person:송강호");
    assert.equal(e?.as, "Kim Ki-taek");
  });

  test("degree 는 양방향을 함께 센다", () => {
    assert.equal(g.degree("movie:외딴영화"), 0);
    assert.equal(g.degree("movie:기생충"), 4);
  });
});

describe("collectEvidence — 다리를 건넌다", () => {
  test("씨앗에서 두 홉을 건너 이터널스까지 닿는다", () => {
    const got = collectEvidence(g, ["movie:기생충"], DEFAULT_BUDGET, "bridge");
    assert.ok(titles(got.movies).includes("이터널스"));
    // 《이터널스》 문서에 '기생충' 은 없다. 사람을 거쳐야만 닿는다.
    assert.deepEqual(
      got.paths.get("movie:이터널스")?.map((h) => h.via),
      ["최우식", "마동석"],
    );
  });

  test("씨앗 자신의 경로는 비어 있다 (건너온 것이 아니다)", () => {
    const got = collectEvidence(g, ["movie:기생충"], DEFAULT_BUDGET, "bridge");
    assert.deepEqual(got.paths.get("movie:기생충"), []);
    assert.equal(got.movies[0].title, "기생충");   // 씨앗이 맨 앞
  });

  test("영화가 아닌 씨앗은 무시한다", () => {
    const got = collectEvidence(g, ["person:송강호", "movie:기생충"], DEFAULT_BUDGET, "bridge");
    assert.equal(got.movies[0].title, "기생충");
    assert.equal(got.paths.has("person:송강호"), false);
  });

  test("같은 씨앗이 두 번 들어와도 한 번만 담는다", () => {
    const got = collectEvidence(g, ["movie:기생충", "movie:기생충"], DEFAULT_BUDGET, "bridge");
    assert.equal(titles(got.movies).filter((t) => t === "기생충").length, 1);
  });

  test("홉 수를 줄이면 멀리 있는 것이 빠진다", () => {
    const got = collectEvidence(g, ["movie:기생충"], { ...DEFAULT_BUDGET, maxHops: 1 }, "bridge");
    assert.ok(titles(got.movies).includes("부산행"));
    assert.equal(titles(got.movies).includes("이터널스"), false);
  });

  /**
   * 버린 것을 **세어서 말한다.** 이 숫자가 0 이 아니면 "근거가 없다" 와
   * "예산이 모자랐다" 를 구분할 수 있다 — 조용히 버리면 둘이 똑같아 보인다.
   */
  test("작품 한도를 넘기면 버리고, 버린 수를 보고한다", () => {
    const got = collectEvidence(g, ["movie:기생충"], { ...DEFAULT_BUDGET, maxMovies: 2 }, "bridge");
    assert.equal(got.movies.length, 2);
    assert.ok(got.dropped > 0, "버렸으면 dropped 에 남아야 한다");
  });

  /**
   * 법령판의 교훈 — 할당량은 **관계마다** 따로 둔다.
   * '출연'이 압도적으로 많아서 한 덩어리로 담으면 정작 필요한 한 편이 밀린다.
   */
  test("관계별 할당량을 넘기면 담지 않는다", () => {
    const got = collectEvidence(g, ["movie:기생충"], { ...DEFAULT_BUDGET, perRelation: 1 }, "bridge");
    const acted = titles(got.movies).filter((t) => t !== "기생충");
    assert.equal(acted.length, 1, "ACTED_IN 은 한 편만 담겨야 한다");
    assert.ok(got.dropped > 0);
  });

  test("filmography 는 밖으로 나가지 않는다 — X 의 작품만이 답이다", () => {
    // 실측 사고: 《브로커》에서 감독을 타고 그의 다른 영화가 근거에 섞였다 (아이유와 무관하다)
    const got = collectEvidence(g, ["movie:기생충"], DEFAULT_BUDGET, "filmography");
    assert.deepEqual(titles(got.movies), ["기생충"]);
  });

  test("cast 도 그 작품에서 더 나가지 않는다 — 답이 크레딧 안에 있다", () => {
    const got = collectEvidence(g, ["movie:기생충"], DEFAULT_BUDGET, "cast");
    assert.deepEqual(titles(got.movies), ["기생충"]);
  });

  test("이어진 데가 없으면 씨앗만 돌아온다", () => {
    const got = collectEvidence(g, ["movie:외딴영화"], DEFAULT_BUDGET, "bridge");
    assert.deepEqual(titles(got.movies), ["외딴영화"]);
    assert.equal(got.dropped, 0);
  });
});

describe("describePath — 사람이 읽는 한 줄", () => {
  test("다리를 건넌 사람이 화살표에 남는다", () => {
    const got = collectEvidence(g, ["movie:기생충"], DEFAULT_BUDGET, "bridge");
    assert.equal(
      describePath(g, got.paths.get("movie:이터널스")!),
      "기생충 ─최우식─▶ 부산행 ─마동석─▶ 이터널스",
    );
  });

  test("씨앗은 그릴 경로가 없다", () => {
    assert.equal(describePath(g, []), "");
  });
});

describe("healthCheck — 말뭉치가 한 덩어리인가", () => {
  test("아무와도 안 이어진 작품과, 한국·외국을 잇는 사람을 센다", () => {
    const h = healthCheck(g);
    assert.deepEqual(h.isolated, ["movie:외딴영화"]);
    // 마동석만 한국 작품(부산행)과 외국 작품(이터널스) 양쪽에 걸쳐 있다 — 이 프로젝트의 다리다
    assert.equal(h.bridgePeople, 1);
  });
});
