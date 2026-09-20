/**
 * 이어지는 질문 — "그중에 상 받은 건?"
 *
 * 이 모듈의 값어치는 **이어붙이는 것이 아니라 포기하는 것**에 있다.
 * 억지로 이으면 엉뚱한 답이 나오고 사용자는 왜 그런지 알 수 없다. 그래서
 * "가리키는 말이 있는가" 와 "무엇으로 거를지 알아냈는가" 를 따로 판정하고,
 * 둘 중 하나라도 없으면 **이유를 남기고** 새 질문으로 넘긴다.
 *
 * 규칙이 전부 정규식이라 한 글자만 건드려도 조용히 넓어지거나 좁아진다.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectFollowUp, parseFilters } from "../lib/followup.ts";
import type { Movie } from "../lib/types.ts";

const mv = (p: Partial<Movie> & { id: string }): Movie => ({
  tmdbId: 0, title: p.id, originalTitle: p.id, year: null, overview: "",
  genres: [], countries: [], originalLanguage: "ko", popularity: 0,
  voteAverage: 0, voteCount: 0, posterPath: null, collection: null, ...p,
});

const 기생충 = mv({ id: "기생충", year: 2019, voteAverage: 8.5, genres: ["드라마"], awards: [{ award: "황금종려상", year: 2019 }] });
const 부산행 = mv({ id: "부산행", year: 2016, voteAverage: 7.8, genres: ["액션", "공포"] });
const 이터널스 = mv({ id: "이터널스", year: 2021, voteAverage: 6.8, genres: ["액션"], originalLanguage: "en" });
const ALL = [기생충, 부산행, 이터널스];

describe("detectFollowUp — 이어붙일지 말지", () => {
  test("가리키는 말 + 거를 조건이 둘 다 있어야 이어붙인다", () => {
    const fu = detectFollowUp("그중에 상 받은 거 있어?", true);
    assert.equal(fu.isFollowUp, true);
    assert.deepEqual(fu.filters.map((f) => f.label), ["수상작만"]);
    assert.equal(fu.gaveUp, null);
  });

  test("가리키는 말이 없으면 애초에 이어지는 질문이 아니다 (이유도 남기지 않는다)", () => {
    const fu = detectFollowUp("송강호가 나온 영화 알려줘", true);
    assert.equal(fu.isFollowUp, false);
    assert.equal(fu.gaveUp, null);
  });

  /**
   * 포기할 때는 **왜 포기했는지** 남긴다. 화면이 그 문장을 그대로 보여 준다 —
   * 사용자가 "왜 엉뚱한 답이 나왔지" 를 물을 필요가 없어야 한다.
   */
  test("앞선 질문이 없으면 포기하고 이유를 남긴다", () => {
    const fu = detectFollowUp("그중에 상 받은 거 있어?", false);
    assert.equal(fu.isFollowUp, false);
    assert.match(fu.gaveUp ?? "", /앞선 질문이 없어/);
  });

  test("무엇으로 거를지 못 알아내면 포기하고 이유를 남긴다", () => {
    const fu = detectFollowUp("그중에 아무거나 골라줘", true);
    assert.equal(fu.isFollowUp, false);
    assert.match(fu.gaveUp ?? "", /무엇을 걸러야 할지/);
  });

  test("띄어쓰기가 달라도 가리키는 말을 알아본다", () => {
    for (const q of ["그중에 한국 영화만", "그 중에 한국영화만", "이 중 한국 영화"]) {
      assert.equal(detectFollowUp(q, true).isFollowUp, true, q);
    }
  });
});

describe("parseFilters — 무엇으로 거르는가", () => {
  test("수상작만", () => {
    const [f] = parseFilters("그중에 상 받은 거");
    assert.equal(f.label, "수상작만");
    assert.deepEqual(f.apply(ALL).map((m) => m.id), ["기생충"]);
  });

  test("한국 작품만", () => {
    const [f] = parseFilters("그중에 한국 영화만");
    assert.deepEqual(f.apply(ALL).map((m) => m.id), ["기생충", "부산행"]);
  });

  /**
   * '한국' 과 '해외' 는 같은 자리를 두고 다툰다. "해외" 가 나오면 한국 조건은 달지 않는다 —
   * 둘 다 달면 교집합이 **항상 빈 목록**이 되어, 있는 답을 없다고 하게 된다.
   */
  test("해외를 물으면 한국 조건이 같이 붙지 않는다", () => {
    const fs = parseFilters("그중에 해외 작품만");
    assert.deepEqual(fs.map((f) => f.label), ["해외 작품만"]);
    assert.deepEqual(fs[0].apply(ALL).map((m) => m.id), ["이터널스"]);
  });

  test("정렬 조건은 거르지 않고 순서만 바꾼다", () => {
    const [recent] = parseFilters("그중에 최근 거");
    assert.deepEqual(recent.apply(ALL).map((m) => m.id), ["이터널스", "기생충", "부산행"]);

    const [old] = parseFilters("그중에 오래된 거");
    assert.deepEqual(old.apply(ALL).map((m) => m.id), ["부산행", "기생충", "이터널스"]);

    const [best] = parseFilters("그중에 평점 높은 거");
    assert.deepEqual(best.apply(ALL).map((m) => m.id), ["기생충", "부산행", "이터널스"]);
  });

  test("정렬은 원본 배열을 건드리지 않는다", () => {
    const before = ALL.map((m) => m.id);
    parseFilters("그중에 최근 거")[0].apply(ALL);
    assert.deepEqual(ALL.map((m) => m.id), before);
  });

  test("장르 이름이 그대로 들어 있으면 그 장르만", () => {
    const [f] = parseFilters("그중에 공포 영화");
    assert.equal(f.label, "공포 장르만");
    assert.deepEqual(f.apply(ALL).map((m) => m.id), ["부산행"]);
  });

  test("조건이 여럿이면 차례로 겹쳐 적용된다", () => {
    const fs = parseFilters("그중에 한국 액션 영화 최근 순으로");
    assert.deepEqual(fs.map((f) => f.label).sort(), ["최근 순", "액션 장르만", "한국 작품만"].sort());
    let ms = ALL;
    for (const f of fs) ms = f.apply(ms);
    assert.deepEqual(ms.map((m) => m.id), ["부산행"]);   // 이터널스는 액션이지만 한국이 아니다
  });

  test("거를 조건이 하나도 없으면 빈 목록", () => {
    assert.deepEqual(parseFilters("그중에 아무거나"), []);
  });
});
