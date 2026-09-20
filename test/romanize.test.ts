/**
 * 로마자 대조 — 배역 질문이 전부 여기를 지난다.
 *
 * TMDB 는 배역명을 로마자로만 준다(실측: 배역명 37,773개 중 한글은 손에 꼽는다).
 * 그래서 "기택 역을 맡은 배우는?" 이 답이 되려면 `기택 ↔ Kim Ki-taek` 이 맞아야 하고,
 * 이 판정이 **한 칸만 흔들려도 배역 질문 22문항이 통째로 흔들린다.**
 *
 * 규칙이 전부 문자열 치환이라 눈으로는 검증이 안 된다 — 치환 하나를 끼워 넣으면
 * 전혀 다른 글자에서 터진다. 그래서 여기에 못을 박는다.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { nameMatches, romanize, syllables, loose } from "../lib/romanize.ts";

describe("syllables — 음절 경계를 유지한다", () => {
  test("음절 하나가 배열 한 칸", () => {
    assert.deepEqual(syllables("기택"), ["gi", "taek"]);
    assert.deepEqual(syllables("조태오"), ["jo", "tae", "o"]);
  });

  test("한글이 아닌 글자는 그대로 둔다", () => {
    assert.deepEqual(syllables("A조"), ["A", "jo"]);
  });

  /**
   * 경계를 지키는 이유. 붙여 놓고 규칙을 돌리면 **음절을 넘어** 규칙이 걸린다 —
   * 조태오를 이어 붙인 "jotaeo" 는 태의 e 와 오의 o 가 만나 `eo→u` 에 걸려 "jotau" 가 되고,
   * 데이터의 "Tae-oh"(마디가 나뉘어 있다)와 서로 어긋나 버린다.
   */
  test("이어 붙이면 태+오 경계에서 eo 규칙이 잘못 걸린다", () => {
    assert.equal(romanize("조태오"), "jotaeo");
    assert.equal(loose("jotaeo"), "jodau");        // 붙여서 뭉개면 이렇게 된다
    assert.equal(syllables("조태오").map(loose).join(""), "jodeo");  // 음절마다 뭉개면 이렇게
    assert.notEqual(loose("jotaeo"), syllables("조태오").map(loose).join(""));
    // 그래서 nameMatches 는 음절마다 뭉갠다 — 실제로 맞는다
    assert.ok(nameMatches("조태오", "Jo Tae-oh"));
  });
});

describe("nameMatches — 표기가 흔들려도 같은 이름을 맞춘다", () => {
  test("표기법대로 적힌 것", () => {
    assert.ok(nameMatches("기택", "Kim Ki-taek"));
    assert.ok(nameMatches("대수", "Oh Dae-su"));
    assert.ok(nameMatches("금자", "Lee Geum-ja"));
    assert.ok(nameMatches("기우", "Kim Ki-woo"));
  });

  test("같은 글자를 다르게 적어도 맞는다 — 이게 이 모듈의 존재 이유다", () => {
    // 말뭉치 실측: 석 계열 마디 589개가 seok(379)·suk(135) 두 갈래로 갈려 있다
    for (const roman of ["Ma Seok-do", "Ma Suk-do"]) {
      assert.ok(nameMatches("석도", roman), `석도 ↔ ${roman}`);
    }
    assert.ok(nameMatches("자성", "Lee Ja-sung"));   // 표기법이면 Ja-seong
    assert.ok(nameMatches("숙희", "Sook-hee"));      // 희 hui ↔ hee
    assert.ok(nameMatches("우진", "Woo-jin"));       // oo ↔ u
  });

  /**
   * 영·경·정은 TMDB 에 두 가지로 적혀 있다 — Ji-yeong 과 Ji-young.
   * 표기법(yeong)만 맞고 ou 표기는 어긋나 있었다. **같은 글자가 표기에 따라
   * 반은 맞고 반은 틀리는** 상태였고, 배역명 중 `X-young` 형태가 231개다.
   */
  test("영·경·정 — yeong 표기와 ou 표기 둘 다 맞아야 한다", () => {
    for (const [korean, a, b] of [
      ["지영", "Ji-yeong", "Ji-young"],
      ["미경", "Mi-gyeong", "Mi-kyoung"],
      ["정우", "Jeong-woo", "Joung-woo"],
    ] as const) {
      assert.ok(nameMatches(korean, a), `${korean} ↔ ${a}`);
      assert.ok(nameMatches(korean, b), `${korean} ↔ ${b}`);
    }
    assert.ok(nameMatches("영희", "Young-hee"));
    assert.ok(nameMatches("김지영", "Kim Ji-young"));
  });

  /**
   * ⚠️ 남은 구멍. 영 단독 마디를 세어 보면 **세 갈래**다 —
   * young 1,517 · yeong 309 · **yong 267**. 앞의 둘은 맞고 yong 은 어긋난다.
   *
   * 고치려면 `yong→yung` 을 넣으면 되는데, 그러면 **용(yong)과 영이 같은 글자가 된다**
   * (영수 ↔ Yong-su, 용수 ↔ Young-su). 재현율 267마디를 얻고 정밀도를 잃는 교환이라
   * 지금은 **알면서 두는 선**이다. 넣기로 하면 이 테스트가 먼저 뒤집힌다.
   */
  test("알려진 한계 — 영을 Yong 으로 적은 267마디는 아직 못 맞춘다", () => {
    assert.equal(nameMatches("영수", "Yong-su"), false);
    assert.ok(nameMatches("용수", "Yong-su"));        // 용은 제대로 맞는다
  });

  /**
   * 이씨는 표기가 네 갈래다 — 말뭉치 실측 Lee 877 · **Yi 171** · Ri 133 · Rhee 3.
   * Lee 만 처리하고 있어서 `이순신 ↔ Admiral Yi Sun-Shin` 이 어긋났고,
   * 그 바람에 《명량》 근거에 **배우가 한 명도 안 실렸다.**
   * Ri·Rhee 는 리(李)·리 와 헷갈려 손대지 않았다 — 알면서 두는 선이다.
   */
  test("이씨 — Lee 와 Yi 둘 다 맞는다", () => {
    assert.ok(nameMatches("이순신", "Admiral Yi Sun-Shin"));
    assert.ok(nameMatches("이선균", "Yi Sun-kyun"));
    assert.ok(nameMatches("이선균", "Lee Sun-kyun"));
    // 마디 전체가 "yi" 일 때만 떼므로 중국어 이름은 건드리지 않는다
    assert.equal(nameMatches("영수", "Ying-su"), false);
  });

  test("데이터에 한글이 그대로 든 예외", () => {
    assert.ok(nameMatches("진구", "Jin-goo (진구)"));
  });

  test("빈 값·한 글자는 맞지 않는다 (뭉갠 길이 3 미만은 버린다)", () => {
    assert.equal(nameMatches("", "Kim Ki-taek"), false);
    assert.equal(nameMatches("기택", ""), false);
    assert.equal(nameMatches("이", "Lee Ja-sung"), false);
  });
});

describe("nameMatches — 음절 경계 규칙", () => {
  /**
   * 마디를 넘어 한가운데가 먹히는 것을 막는다.
   * "임지" 를 뭉개면 `imji` 이고, 이것은 "Kim Ji-young" 을 이어 붙인 `gimjiyung`
   * **안에 그대로 들어 있다.** 마디(`Kim`·`Ji`·`young`) 단위로 대조하기 때문에 걸리지 않는다.
   */
  test("마디 한가운데를 먹지 않는다", () => {
    assert.ok(loose("Kim") + loose("Ji") + loose("young") === "gimjiyung");
    assert.ok("gimjiyung".includes(syllables("임지").map(loose).join("")));  // 부분 문자열로는 들어 있다
    assert.equal(nameMatches("임지", "Kim Ji-young"), false);               // 그래도 맞지 않는다
  });

  /**
   * ⚠️ 다만 **마디 경계에 딱 맞는 오탐은 못 막는다.**
   * 치 → chi → (ch→j) → ji 라서 김치와 김지가 같은 글자가 된다.
   * 소스 주석이 "김치는 어디와도 맞지 않는다" 고 적어 두었으나 실제로는 맞는다 —
   * 음절 경계 규칙이 막는 것은 *마디 가운데* 뿐이다.
   *
   * 실제 영향은 route.ts 의 흔한말 목록·용언 어미 필터가 앞에서 걸러 준다.
   * 여기서는 **알고 있는 한계**로 못을 박아 둔다. 고칠 때 이 테스트가 뒤집힌다.
   */
  test("알려진 한계 — 마디 경계에 딱 맞는 오탐 (김치 ↔ 김지)", () => {
    assert.deepEqual(syllables("김치").map(loose), ["gim", "ji"]);
    assert.deepEqual(syllables("김지").map(loose), ["gim", "ji"]);
    assert.equal(nameMatches("김치", "Kim Ji-young"), true);   // 오탐이지만 현재 동작
  });
});
