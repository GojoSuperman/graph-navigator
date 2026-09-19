/**
 * BM25 — 씨앗 찾기와 베이스라인 비교에 같이 쓴다.
 *
 * law-navigator 에서 그대로 가져왔다. 도메인과 무관한 코드이고,
 * **비교군이 같은 토크나이저를 써야 비교가 공정하다**는 조건도 그대로다.
 *
 * 흔한 단어가 점수를 지배하는 문제(법령에서는 '개인정보', 영화에서는 '영화·이야기')를
 * BM25 의 IDF 가 자동으로 깎아 준다.
 *
 * 한국어는 공백 분리만으로는 '개인정보를/개인정보가'가 다른 낱말이 된다.
 * 형태소 분석기는 무거우므로, 2글자 이상 덩어리를 뽑는 가벼운 토크나이저를 쓴다.
 * (조사가 붙은 형태도 그대로 색인되므로 완전하지는 않다 — 개선 여지로 남겨 둔다)
 */

/**
 * 한국어는 어절 단위로 자르면 조사·어미 때문에 같은 말이 다른 토큰이 된다.
 *   질문 "봉준호가"  vs  본문 "봉준호의"  → 겹치는 토큰이 없다
 * law-navigator 의 첫 측정에서 그래프가 BM25 에 졌던 원인이 이것이었다
 * (질문 "파기해야" vs 조문 "파기하여야"). 글자 바이그램으로 바꿔 19% → 75%.
 *
 * 형태소 분석기는 무거우므로 **글자 바이그램**을 쓴다 (Lucene 의 CJK 처리와 같은 방식).
 *   봉준호가 → 봉준 · 준호 · 호가
 *   봉준호의 → 봉준 · 준호 · 호의
 * '봉준'·'준호' 가 공통으로 남아 매칭된다. 영문·숫자는 어미 문제가 없으니 통째로 둔다.
 */
export const tokenize = (s: string): string[] => {
  const out: string[] = [];
  for (const m of s.match(/[0-9A-Za-z]+|[가-힣]+/g) ?? []) {
    if (/^[가-힣]/.test(m)) {
      if (m.length === 1) out.push(m);
      for (let i = 0; i < m.length - 1; i++) out.push(m.slice(i, i + 2));
    } else {
      out.push(m.toLowerCase());
    }
  }
  return out;
};

export interface Doc {
  id: string;
  /** 제목 — 본문보다 강한 신호라 여러 번 센다 */
  title: string;
  text: string;
}

const TITLE_BOOST = 3;

export class BM25 {
  private df = new Map<string, number>();
  private docs: Array<{ id: string; tf: Map<string, number>; len: number }> = [];
  private avg = 1;
  private k1 = 1.2;
  private b = 0.75;

  constructor(items: Doc[]) {
    for (const d of items) {
      const toks = [
        ...Array.from({ length: TITLE_BOOST }, () => tokenize(d.title)).flat(),
        ...tokenize(d.text),
      ];
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ id: d.id, tf, len: toks.length });
    }
    if (this.docs.length) {
      this.avg = this.docs.reduce((s, d) => s + d.len, 0) / this.docs.length;
    }
  }

  search(query: string, k = 10): Array<{ id: string; score: number }> {
    const qt = tokenize(query);
    const N = this.docs.length;
    const out: Array<{ id: string; score: number }> = [];
    for (const d of this.docs) {
      let s = 0;
      for (const t of qt) {
        const f = d.tf.get(t);
        if (!f) continue;
        const n = this.df.get(t)!;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * (d.len / this.avg)));
      }
      if (s > 0) out.push({ id: d.id, score: s });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, k);
  }
}
