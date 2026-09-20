/**
 * 한글 → 로마자, 그리고 **느슨한 대조**.
 *
 * 왜 필요한가 — TMDB 는 배역명을 로마자로만 준다. `language=ko-KR` 로 요청해도
 * 바뀌지 않는다 (실측: 4,022개 배역명 중 한글은 19개, 그나마 누군가 손으로
 * "Jin-goo (진구)" 라고 적은 예외다).
 *
 *   질문  "기생충에서 **기택** 역"
 *   데이터 송강호 as "Kim **Ki-taek**"
 *
 * 그런데 로마자 표기가 **표준을 따르지 않는다.** 실제 데이터에서:
 *   자성 → "Ja-sung"   (국어의 로마자 표기법이면 Ja-seong)
 *   안   → "Ahn"       (표기법이면 An)
 *   대수 → "Dae-su"    (표기법과 일치)
 *
 * 그래서 양쪽을 **같은 규칙으로 뭉갠 뒤** 부분 문자열로 맞춘다.
 * 정확한 변환이 목적이 아니라 **같은 이름인지 판정**하는 것이 목적이다.
 * 법령판에서 "개인정보 보호법"과 "개인정보보호법"을 공백 무시로 맞춘 것과 같은 자리.
 */

const CHO = ["g","kk","n","d","tt","r","m","b","pp","s","ss","","j","jj","ch","k","t","p","h"];
const JUNG = ["a","ae","ya","yae","eo","e","yeo","ye","o","wa","wae","oe","yo","u","wo","we","wi","yu","eu","ui","i"];
const JONG = ["","k","k","ks","n","nj","nh","t","l","lk","lm","lb","ls","lt","lp","lh","m","p","ps","t","t","ng","t","t","k","t","p","t"];

/** 음절 하나씩 로마자로. **음절 경계를 유지**하는 것이 중요하다 — 아래 설명 참고. */
export function syllables(s: string): string[] {
  const out: string[] = [];
  for (const ch of s) {
    const code = ch.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) { out.push(ch); continue; }
    const cho = Math.floor(code / 588);
    const jung = Math.floor((code % 588) / 28);
    const jong = code % 28;
    out.push(CHO[cho] + JUNG[jung] + JONG[jong]);
  }
  return out;
}

/** 국어의 로마자 표기법(음절 단위, 연음 규칙은 생략) */
export const romanize = (s: string): string => syllables(s).join("");

/**
 * 표기 흔들림을 뭉갠다. **양쪽에 똑같이 적용**하므로 정확도보다 일관성이 중요하다.
 *   Seok-do / Suk-do  →  같은 모양으로 (말뭉치 실측: 석 계열 589마디가 이 둘로 갈려 있다)
 *   Ji-yeong / Ji-young  →  같은 모양으로 (영 단독 2,093마디 중 yeong 309 · young 1,517)
 *
 * 규칙에 없는 표기는 그대로 어긋난다 — 예: Sok-do 는 맞지 않는다(말뭉치에 없어서 두었다).
 *
 * ⚠️ 이 규칙들은 **음절 안에서만** 적용해야 한다. 음절을 이어 붙인 뒤 적용하면
 * 경계를 넘어 망가진다 — 조태오(조|태|오)를 붙이면 "jotaeo" 가 되고, 태의 'e' 와
 * 오의 'o' 가 만나 `eo→u` 규칙에 걸려 "jotau" 가 된다. 데이터의 "Tae-oh" 는
 * 마디가 나뉘어 있어 그런 일이 없으므로 서로 어긋난다.
 */
function normPart(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z가-힣]/g, "")
    .replace(/ch/g, "j")          // Chung / Jung
    .replace(/sh/g, "s")          // Shin / Sin
    .replace(/h/g, "")            // Ahn→An, Hwang→wang, Oh→O (양쪽 동일 적용)
    .replace(/ee/g, "i")          // Pepsee → Pepsi
    .replace(/ui/g, "i")          // 희 hui → hee (Sook-hee)
    .replace(/oo/g, "u")          // Woo-jin → Wu-jin
    .replace(/wu/g, "u")
    // 영·경·정을 TMDB 는 Young·Kyoung·Joung 으로도 적는다. 표기법(yeong)은
    // 아래 eo→u 로 뭉개지지만 ou 표기는 그대로 남아 **같은 글자가 어긋났다.**
    .replace(/ou/g, "u")          // Ji-young → Ji-yung (= 지영 jiyeong → jiyung)
    .replace(/eo/g, "u")          // Seok → Suk, Seong → Sung
    .replace(/eu/g, "u")
    .replace(/ae/g, "e")
    .replace(/oe/g, "o")
    .replace(/k/g, "g")           // Ki-taek → gi-taeg
    .replace(/t/g, "d")
    .replace(/p/g, "b")
    .replace(/c/g, "g")           // Ki-taek → gi-taeg
    // 이·임 성씨는 Lee/Lim 으로 적는다. 모음 정리가 끝난 뒤에 떼어야
    // "Lee" → "li" → "i" 가 된다 (앞에서 떼면 "lee" 라 걸리지 않는다).
    .replace(/^l(?=i)/, "")
    // 같은 성씨를 Yi 로도 적는다 — 말뭉치 실측 Lee 877마디 · **Yi 171마디**.
    // 마디 전체가 "yi" 일 때만 떼어 Ying·Yin·Yip 같은 중국어 이름을 건드리지 않는다.
    .replace(/^yi$/, "i");
}

/** 겹자음 정리는 **이어 붙인 뒤** 한 번만 — 양쪽에 같은 시점에 적용해야 한다 */
const squash = (s: string) => s.replace(/(.)\1+/g, "$1");

/** 문자열 전체를 뭉갠다 (테스트·진단용) */
export const loose = (s: string) => squash(normPart(s));

/**
 * 한글 이름이 로마자 배역명과 같은 이름인가.
 *
 * ⚠️ 단순 부분 문자열로 보면 조용히 망가진다. 두 글자 한글이 로마자
 * '성+이름' 한가운데에 통째로 먹히기 때문이다 — "임지" 를 뭉갠 `imji` 는
 * `Kim Ji-young` 을 이어 붙인 `gimjiyung` 안에 그대로 들어 있다.
 *
 * 그래서 **음절 경계**를 요구한다. 로마자 이름은 공백·하이픈으로 마디가 나뉘므로,
 * 그 마디들과 대조한다. "기택" 은 `Kim Ki-taek` 의 마디 `Ki`+`taek` 와 맞고,
 * "임지" 는 어느 마디 묶음과도 맞지 않는다.
 *
 * ⚠️ **마디 경계에 딱 맞는 오탐은 이 규칙으로 못 막는다.** 치 → chi → (ch→j) → ji 라서
 * "김치" 는 `Kim`+`Ji` 와 맞는다. 앞단(route.ts 의 흔한말·용언 어미 필터)이 걸러 주는 데
 * 기대고 있는 자리다 — test/romanize.test.ts 에 한계로 박아 두었다.
 */
export function nameMatches(korean: string, roman: string): boolean {
  if (!korean || !roman) return false;
  if (roman.includes(korean)) return true;               // 데이터에 한글이 그대로 든 경우

  // 음절마다 따로 뭉갠 뒤 이어 붙인다 (경계를 넘는 규칙 적용을 막는다)
  const a = squash(syllables(korean).map(normPart).join(""));
  if (a.length < 3) return false;

  // 로마자 이름을 마디로 쪼갠 뒤, 이어 붙인 조각들과 대조한다
  const parts = roman.split(/[\s\-·/,()]+/).filter(Boolean).map(normPart).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    let acc = "";
    for (let j = i; j < parts.length; j++) {
      acc += parts[j];
      if (squash(acc) === a) return true;
      if (acc.length > a.length) break;
    }
  }
  return false;
}
