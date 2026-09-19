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

/** 국어의 로마자 표기법(음절 단위, 연음 규칙은 생략) */
export function romanize(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) { out += ch; continue; }
    const cho = Math.floor(code / 588);
    const jung = Math.floor((code % 588) / 28);
    const jong = code % 28;
    out += CHO[cho] + JUNG[jung] + JONG[jong];
  }
  return out;
}

/**
 * 표기 흔들림을 뭉갠다. **양쪽에 똑같이 적용**하므로 정확도보다 일관성이 중요하다.
 *   Seok-do / Suk-do / Sokdo  →  전부 같은 모양으로
 */
export function loose(s: string): string {
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
    .replace(/eo/g, "u")          // Seok → Suk, Seong → Sung
    .replace(/eu/g, "u")
    .replace(/ae/g, "e")
    .replace(/oe/g, "o")
    .replace(/k/g, "g")           // Ki-taek → gi-taeg
    .replace(/t/g, "d")
    .replace(/p/g, "b")
    .replace(/c/g, "g")
    .replace(/(.)\1+/g, "$1");    // 겹자음 정리
}

/** 한글 이름이 로마자 배역명과 같은 이름인가 */
export function nameMatches(korean: string, roman: string): boolean {
  if (!korean || !roman) return false;
  // 데이터에 한글이 그대로 든 경우 (드물지만 있다)
  if (roman.includes(korean)) return true;
  const a = loose(romanize(korean));
  const b = loose(roman);
  return a.length >= 3 && b.includes(a);
}
