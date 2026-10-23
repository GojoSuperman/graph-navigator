/**
 * 예시: "기생충에서 기택 역을 맡은 배우는?" → 답에 송강호가 Kim Ki-taek 역으로 나온다.
 *
 * 배역 질문은 한글 배역명(기택)과 TMDB 로마자 배역명(Kim Ki-taek)을 이어야 답이 된다.
 * 질문 하나가 route → 시작점 → 배역 대조를 모두 지나므로, 그 끝에서 결과만 확인한다.
 * 픽스처 그래프만 쓴다 — LLM 과 네트워크 없이 돈다.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MovieGraph } from "../lib/graph.ts";
import { ask } from "../lib/ask.ts";
import type { GraphData, Movie, Person } from "../lib/types.ts";

const mv = (id: string): Movie => ({
  id: `movie:${id}`, tmdbId: 0, title: id, originalTitle: id, year: 2019, releaseDate: "2019-05-30", overview: "",
  genres: [], countries: [], originalLanguage: "ko", popularity: 0,
  voteAverage: 0, voteCount: 0, posterPath: null, collection: null,
});
const pr = (id: string): Person => ({
  id: `person:${id}`, tmdbId: 0, name: id, originalName: id, department: "Acting", popularity: 0,
});

const DATA: GraphData = {
  movies: [mv("기생충")],
  people: [pr("송강호"), pr("최우식")],
  collections: [],
  edges: [
    { from: "person:송강호", to: "movie:기생충", kind: "ACTED_IN", origin: "api", order: 0, as: "Kim Ki-taek" },
    { from: "person:최우식", to: "movie:기생충", kind: "ACTED_IN", origin: "api", order: 1, as: "Kim Ki-woo" },
  ],
};

test("기택 역을 물으면 송강호가 Kim Ki-taek 역으로 답에 나온다", () => {
  const r = ask(new MovieGraph(DATA), "기생충에서 기택 역을 맡은 배우는?");
  assert.equal(r.refused, false);
  assert.deepEqual(r.characters.map((c) => [c.person, c.as]), [["송강호", "Kim Ki-taek"]]);
});
