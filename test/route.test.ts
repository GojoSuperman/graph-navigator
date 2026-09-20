/**
 * 씨앗 찾기 — 질문이 가리킨 작품을 후보로 올리는가.
 *
 * 제목 대조는 **양쪽으로 조용히 틀린다.** 느슨하면 남의 낱말 조각에 걸리고
 * (《아이》가 '아이유가' 에), 빡빡하면 진짜 제목을 통째로 버린다
 * (《시》·《업》·《콜》 같은 한 글자 제목 36편). 그래서 둘 다 못 박아 둔다.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MovieGraph } from "../lib/graph.ts";
import { seedsFromTitle, titlesIn, bracketedTitle } from "../lib/route.ts";
import type { GraphData, Movie } from "../lib/types.ts";

const mv = (title: string, popularity = 0): Movie => ({
  id: `movie:${title}`, tmdbId: 0, title, originalTitle: title, year: 2010,
  releaseDate: "2010-05-13", overview: "", genres: [], countries: [],
  originalLanguage: "ko", popularity, voteAverage: 0, voteCount: 0,
  posterPath: null, collection: null,
});

const data: GraphData = {
  movies: [mv("시", 10), mv("업", 5), mv("아이", 3), mv("기생충", 20), mv("범죄도시 2", 8)],
  people: [],
  edges: [],
  collections: [],
};
const g = new MovieGraph(data);
const titles = (q: string) => seedsFromTitle(q, g).map((id) => id.replace("movie:", ""));

describe("bracketedTitle — 괄호 안에 든 제목", () => {
  test("네 가지 괄호를 모두 본다", () => {
    for (const q of ["《시》로 받은 상", "〈시〉로 받은 상", "「시」로 받은 상", "'시'로 받은 상"]) {
      assert.equal(bracketedTitle(q, "시"), true, q);
    }
  });

  test("괄호가 없으면 아니다 — 이게 가드의 존재 이유다", () => {
    assert.equal(bracketedTitle("영화 시의 감독은?", "시"), false);
  });

  test("괄호 안이라도 다른 제목이면 아니다", () => {
    assert.equal(bracketedTitle("《업》은 어떤 영화야?", "시"), false);
  });
});

describe("seedsFromTitle — 한 글자 제목", () => {
  /**
   * 실측 — "이창동 감독이 《시》로 2010년 칸 영화제에서 받은 상은?" 이
   * 《시》를 한 편도 데려오지 못했다. 그래프에는 이창동 ─DIRECTED─▶ 시 가
   * 분명히 있었는데, 제목 대조의 `length >= 2` 가 후보에서 빼고 있었다.
   */
  test("괄호가 있으면 데려온다", () => {
    assert.deepEqual(titles("이창동 감독이 《시》로 받은 상은?"), ["시"]);
    assert.deepEqual(titles("《업》은 어떤 영화야?"), ["업"]);
  });

  /**
   * 가드를 통째로 풀면 안 되는 이유. 평가셋 152문항에서 글자 '시' 는 18문항에
   * 그냥 들어 있다 — 전부 제목이 아니라 남의 낱말 조각이다.
   */
  test("괄호가 없으면 낱말 조각에 걸리지 않는다", () => {
    assert.deepEqual(titles("시상식에서 받은 상은?"), []);
    assert.deepEqual(titles("영화 시의 감독은 누구인가요?"), []);
  });

  test("두 글자 이상은 전과 같다 — 괄호가 없어도 잡힌다", () => {
    assert.deepEqual(titles("기생충 줄거리 알려줘"), ["기생충"]);
  });

  test("긴 제목부터 맞춘다 — 《범죄도시 2》를 《범죄도시》로 끊지 않는다", () => {
    assert.deepEqual(titles("범죄도시 2 재밌어?"), ["범죄도시 2"]);
  });
});

describe("titlesIn — 질문에 등장하는 모든 작품", () => {
  const found = (q: string) => titlesIn(q, g).map((m) => m.title);

  test("한 글자 제목도 괄호가 있으면 포함된다", () => {
    assert.deepEqual(found("《시》와 기생충 중 뭐가 먼저야?"), ["기생충", "시"]);
  });

  test("괄호가 없으면 한 글자 제목은 빠진다", () => {
    assert.deepEqual(found("시상식 얘기야"), []);
  });

  /**
   * 회귀 방지 — 말뭉치가 커지며 《아이》(2022)가 들어오자 "**아이**유가 나온
   * 영화" 에 걸렸던 사고. 두 글자 이하를 끝까지 대조하는 것이 그 방어이고,
   * 한 글자 제목을 여는 이번 변경이 그 방어를 건드리면 안 된다.
   *
   * (같은 방어가 seedsFromTitle 에는 없다 — 거기는 접두 대조라 《아이》가
   *  '아이유가' 에 걸린다. 씨앗이 넉넉히 들어오고 뒤에서 걸러지는 구조다.)
   */
  test("두 글자 제목이 남의 이름 앞부분에 걸리지 않는다", () => {
    assert.deepEqual(found("아이유가 나온 영화는?"), []);
  });
});
