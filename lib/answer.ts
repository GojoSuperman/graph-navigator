/**
 * 답변 문장 생성 — 이 파일이 **유일하게 LLM 을 호출하는 곳**이다.
 *
 * 탐색(graph.ts)·라우팅(route.ts)·조립(ask.ts)에는 LLM 이 한 줄도 없다.
 * 무엇을 근거로 데려왔는지를 모델 없이 검증할 수 있어야 하기 때문이고,
 * 그래서 평가(evaluate.ts)가 비용 0 으로 돌아간다.
 *
 * ── 2겹 차단 (law-navigator 에서 그대로) ────────────────────────────
 *   코드 층   근거가 없거나 전제가 틀렸으면 **호출 자체를 하지 않는다.**
 *             호출하지 않으면 지어낼 기회가 없다.
 *   프롬프트 층 "아래 근거에만 있는 사실을 쓰라. 없으면 없다고 하라."
 */

import type { AskResult } from "./ask.ts";

const BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
export const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

export interface AnswerResult {
  text: string | null;
  /** 왜 없는지 — 비어 있는 것과 고장난 것을 사용자가 구분할 수 있어야 한다 */
  reason: string;
  model?: string;
}

export const SYSTEM = `너는 영화 정보를 **주어진 근거만으로** 답하는 도우미다.

규칙
1. 아래 「근거」에 적힌 사실만 쓴다. 근거에 없으면 "확인되지 않습니다" 라고 말한다.
   네가 따로 아는 영화 지식을 끌어오지 마라. 근거가 전부다.
2. 작품명은 《》로, 사람 이름은 그대로 쓴다.
3. 두세 문장으로 짧게. 목록이 자연스러우면 목록으로.
4. 근거가 질문과 어긋나면 그렇다고 말한다. 억지로 답을 만들지 마라.
5. **질문에 조건이 여럿이면 전부 확인하고 답한다.** 하나만 맞는 작품을 답이라고
   내놓지 마라. 「질문의 낱말이 근거에서 확인되는가」 블록이 있으면 그것이
   코드가 대조한 사실이다 — "근거 어디에도 없음" 인 낱말은 **없는 것이다.**
   그런 조건이 있으면 "…는 확인되지 않습니다" 라고 먼저 말하고, 부분적으로만
   맞는 작품은 "일부만 맞는다" 고 밝혀서 내놓는다.
6. **「여러 작품에 모두 참여한 사람」 블록이 있으면 그것이 답이다.** 코드가 계산한
   교집합이고, 조단역까지 전수로 본 결과다. 아래 작품별 출연 목록은 **주연 몇 명만**
   실린 것이므로, 그것을 눈으로 대조해 교집합을 다시 고르지 마라 —
   답이 조단역이면 작품별 목록에는 없다.
7. 한국어로 답한다.`;


/**
 * 질문의 낱말이 근거에서 실제로 확인되는지 **코드가 재서** 모델에게 준다.
 *
 * 실측 — "제주도에 관련된 영화중 민간인을 빨갱이로 죽인 사건":
 *   모델이 《최후의 증인》을 답이라고 했다. 줄거리에 '빨갱이' 가 있어서다.
 *   그런데 그 영화는 지리산·6.25 이야기고 **'제주도' 는 어디에도 없다.**
 *   조건 하나만 맞는 것을 답으로 내놓은 것이다.
 *
 * "조건을 전부 확인하라" 고 프롬프트에 적어도 고쳐지지 않았다. 모델에게
 * 대조를 시키는 대신 **대조 결과를 건네주는** 것이 맞다 — 글자가 있는지 없는지는
 * 코드가 틀릴 수 없고, 그러면 모델은 판단만 하면 된다.
 */
const TERM_NOISE = new Set([
  "영화", "작품", "이야기", "내용", "줄거리", "사건", "관련", "관련된", "대한", "대해",
  "알려줘", "알려", "추천", "뭐야", "뭔가요", "무엇", "어떤", "어떤거지", "누구", "있는",
  "나오는", "나온", "출연", "출연한", "주연", "조연", "연기", "연기한", "맡은", "등장",
  "감독", "배우", "다룬", "그린", "중에", "중인", "정도", "같은", "함께",
]);

function termCheck(r: AskResult): string[] {
  /**
   * **글자 대조는 줄거리로 답하는 질문에만 쓴다.**
   *
   * 이 블록은 근거의 제목·줄거리에서 질문의 낱말을 찾는다. 그런데 사람은
   * 줄거리에 안 적혀 있다 — **출연진에 적혀 있다.** 그래서 인물 질문에 쓰면
   * "그 사람이 나온 작품이 없다" 는 거짓을 모델에게 건네게 된다.
   *
   * 실측 — 세 가지로 물었더니 근거 12편은 똑같았는데 답만 갈렸다:
   *   "황정민 배우가 나온 영화"    → 호프·곡성·서울의 봄 … (맞다)
   *   "황정민이 출연한 영화"       → "확인되지 않습니다"   ('출연한' 이 낱말로 잡혀 블록 생성)
   *   "황정민이 주연으로 나온 영화" → "확인되지 않습니다"   ('주연' 이 낱말로 잡혀 블록 생성)
   *
   * 그래프가 관계로 답을 만들어 냈으면 글자 대조는 할 일이 없다.
   * 이 블록이 필요한 것은 **아무 구조도 못 잡고 줄거리만 남은 질문**이다.
   */
  const structured = r.matchedPeople.length || r.cast.length || r.characters.length ||
    r.commonMovies.length || r.commonPeople.length || r.personAwards.length;
  if (structured) return [];

  const terms = [...new Set(
    (r.question.match(/[가-힣]{2,}/g) ?? [])
      .map((w) => w.replace(/(에서|으로|하는|되는|이라는|라는|에게|까지|부터|보다|처럼|이나|거나|에는|의|을|를|이|가|은|는|와|과|로|도|만|중)$/, ""))
      .filter((w) => w.length >= 2 && !TERM_NOISE.has(w)),
  )].slice(0, 5);
  if (terms.length < 2 || !r.evidence.length) return [];   // 조건이 하나면 대조할 것이 없다

  /**
   * **낱말마다 따로 찾으면 안 된다.** '제주도' 가 《올레》에 있고 '빨갱이' 가
   * 《최후의 증인》에 있다고 해서, 둘을 **모두** 가진 작품이 있는 것은 아니다.
   * 질문이 묻는 것은 결합이므로 **작품 단위로** 몇 개를 만족하는지 센다.
   */
  const scored = r.evidence.map((e) => {
    const text = `${e.title} ${e.overview ?? ""}`;
    return { title: e.title, has: terms.filter((t) => text.includes(t)) };
  }).sort((a, b) => b.has.length - a.has.length);

  const best = scored[0]?.has.length ?? 0;
  if (best === terms.length) return [];   // 전부 만족하는 작품이 있다 — 말할 것 없다

  const rows = [
    "[조건 대조 — 코드가 근거 본문에서 직접 세어 본 것]",
    `질문의 낱말: ${terms.join(" · ")}`,
    `**${terms.length}개를 모두 담은 작품은 근거에 없다.** 가장 많이 맞은 것도 ${best}개다.`,
  ];
  for (const x of scored.slice(0, 3)) {
    const miss = terms.filter((t) => !x.has.includes(t));
    rows.push(`- 《${x.title}》 : 맞음 ${x.has.join("·") || "없음"} / 없음 ${miss.join("·")}`);
  }
  return rows;
}

/**
 * 근거에 실을 수상 기록을 고른다.
 *
 * 실측 사고 — "송강호가 출연한 영화 중 칸 황금종려상을 받은 작품은?" 에
 * "확인되지 않습니다" 라고 답했다. 《기생충》 수상 기록에는 **황금종려상도
 * 아카데미 작품상도 들어 있었다.** 그런데 근거에는 앞 3개만 실렸고,
 * 그 3개가 하필 `아카데미 각본상 · 아카데미 감독상 · Gilde Film Price` 였다.
 * **Gilde Film Price 는 싣고 황금종려상은 버린 것이다.**
 *
 * 자르는 것 자체는 필요하다 — 한 편에 최대 22개가 붙어 있다. 틀린 것은
 * **정렬 없이 앞에서 자른 것**이다. 질문이 가리킨 상을 먼저 싣는다.
 * 무엇을 묻는지는 코드가 글자로 확인할 수 있고, 거기서는 틀릴 일이 없다.
 */
const AWARDS_SHOWN = 6;
function pickAwards(awards: { award: string; year: number | null }[], question: string) {
  const q = question.replace(/\s+/g, "");
  const asked = (name: string) => (name.match(/[가-힣]{2,}/g) ?? []).some((w) => q.includes(w));
  return [...awards]
    .map((a, i) => ({ a, i, hit: asked(a.award) }))
    .sort((x, y) => (x.hit === y.hit ? x.i - y.i : x.hit ? -1 : 1))
    .slice(0, AWARDS_SHOWN)
    .map((x) => x.a);
}

/**
 * 모델에게 보여 줄 근거 — 화면에 뜨는 것과 같은 내용이어야 한다.
 *
 * 내보내는 이유: 답변 채점(scripts/evaluate-answer.ts)이 **모델이 실제로 본 것**에
 * 대고 재야 하기 때문이다. 근거를 따로 다시 조립하면 재는 대상이 달라진다.
 */
export function evidenceBlock(r: AskResult): string {
  const lines: string[] = [];

  /**
   * 별칭을 먼저 알려 준다. TMDB 는 인물을 활동명으로 저장하므로,
   * "돈 리가 나온 영화" 를 물었는데 근거에는 **마동석**으로 적혀 있다.
   * 이 줄이 없으면 모델이 동일인임을 모르고 "확인되지 않습니다" 라고 답한다.
   */
  const withAlias = r.matchedPeople.filter((p) => p.aliases.length);
  if (withAlias.length) {
    lines.push("[같은 사람의 다른 이름]");
    for (const p of withAlias) lines.push(`- ${p.name} = ${p.aliases.join(" = ")}`);
  }

  if (r.cast.length) {
    lines.push("[출연·제작진]");
    for (const c of r.cast) lines.push(`- ${c.name} (${c.role}${c.as ? `, ${c.as} 역` : ""})`);
  }
  if (r.characters.length) {
    lines.push("[배역으로 찾은 사람]");
    for (const c of r.characters) lines.push(`- ${c.person} — 《${c.movie}》 ${c.as} 역`);
  }
  if (r.commonMovies.length) {
    lines.push("[두 사람이 함께 나온 작품]");
    for (const m of r.commonMovies) lines.push(`- 《${m.title}》${m.year ? ` (${m.year})` : ""}`);
  }
  /**
   * 역할을 적어 준다. "(출연 아님, 제작진)" 만으로는 **감독인지 각본인지 알 수 없어서**
   * "《추격자》와 《황해》의 공통 감독은?" 에 "근거에 감독 정보가 없다" 고 답했다 —
   * 나홍진이 바로 윗줄에 적혀 있는데도. 그래프에는 DIRECTED 엣지가 분명히 있다.
   */
  if (r.commonPeople.length) {
    lines.push("[여러 작품에 모두 참여한 사람]");
    for (const p of r.commonPeople) lines.push(`- ${p.name} (${p.role})`);
  }
  if (r.personAwards.length) {
    lines.push("[수상]");
    for (const a of r.personAwards) {
      lines.push(`- ${a.person}: ${a.award}${a.year ? ` (${a.year})` : ""}${a.forTitle ? ` — 《${a.forTitle}》` : ""}`);
    }
  }
  if (r.evidence.length) {
    lines.push("[작품]");
    for (const e of r.evidence) {
      const path = e.path.length ? `  ← ${e.path.map((s) => `${s.fromLabel}에서 ${s.via}를 거쳐`).join(", ")}` : "";
      const shown = pickAwards(e.awards, r.question);
      const aw = shown.length
        ? ` · 수상: ${shown.map((a) => a.award).join(", ")}${e.awards.length > shown.length ? ` 외 ${e.awards.length - shown.length}건` : ""}`
        : "";
      // 연도에 **'개봉' 이라고 적는다.** 괄호 안 숫자만 두었더니 모델이 그것을 개봉
      // 연도로 읽지 못하고 "근거에 명시되어 있지 않습니다" 라고 거절했다 — 9문항이 그랬다.
      // 날짜가 있으면 날짜까지 — "개봉일은?" 은 연도로 답이 되지 않는다
      const when = e.releaseDate
        ? ` (${e.releaseDate.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_m, y, mo, d) => `${y}년 ${Number(mo)}월 ${Number(d)}일`)} 개봉)`
        : e.year ? ` (${e.year}년 개봉)` : "";
      lines.push(`- 《${e.title}》${when} · ${e.genres.join("/")} · 평점 ${e.voteAverage.toFixed(1)}${aw}${path}`);
      /**
       * 크레딧을 줄거리보다 **먼저** 적는다. 줄거리에는 배우도 배역도 없으므로
       * 사람을 묻는 질문은 이 줄에서만 답이 나온다.
       * 배역명은 로마자 그대로 둔다 — 데이터가 그렇고, 바꾸면 없는 것을 지어내게 된다.
       */
      // 출연진을 묻는 질문은 위 [출연·제작진] 블록이 답이다. 여기에 또 실으면
      // **동명이작의 크레딧이 섞인다** — "괴물에 나온 배우들" 에 고레에다의
      // 2023년작 출연진을 답한 사고가 그것이다.
      if (e.credits.length && !r.cast.length) {
        const dir = e.credits.filter((c) => c.role !== "출연");
        const act = e.credits.filter((c) => c.role === "출연");
        const parts: string[] = [];
        if (dir.length) parts.push(dir.map((c) => `${c.role} ${c.name}`).join(" · "));
        if (act.length) parts.push(`출연 ${act.map((c) => `${c.name}${c.as ? `(${c.as} 역)` : ""}`).join(" · ")}`);
        lines.push(`    ${parts.join(" · ")}`);
      }
      if (e.overview) lines.push(`    줄거리: ${e.overview.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  lines.push(...termCheck(r));
  return lines.join("\n");
}

/**
 * @param userKey 쓰는 사람이 가져온 키. 배포본에서는 이것만 쓴다.
 *   서버 키(OPENAI_API_KEY)는 로컬 개발용 폴백이다 —
 *   공개된 서버가 제 키로 모델을 돌리면 남의 지갑이 열린다.
 */
export async function generateAnswer(r: AskResult, userKey?: string): Promise<AnswerResult> {
  // ── 코드 층 ────────────────────────────────────────────────────────
  if (r.refused) return { text: null, reason: "근거가 없어 호출하지 않았습니다" };
  if (r.premiseBroken) return { text: null, reason: "질문의 전제가 사실이 아니라 호출하지 않았습니다" };
  /**
   * 배포본에서는 **쓰는 사람의 키만** 쓴다.
   * 서버 키를 폴백으로 두면 공개된 순간 남의 지갑으로 모델이 돌아간다.
   * 로컬 개발에서만 .env.local 의 키로 떨어진다.
   */
  const fallback = process.env.NODE_ENV === "production" ? undefined : process.env.OPENAI_API_KEY;
  const key = (userKey ?? "").trim() || fallback;
  if (!key) {
    return { text: null, reason: "OpenAI 키가 없어 근거만 표시합니다 — 상단 ‘설정’에서 넣을 수 있습니다" };
  }

  const evidence = evidenceBlock(r);
  if (!evidence.trim()) return { text: null, reason: "모아 온 근거가 비어 있습니다" };

  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 500,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: r.followUp
              // 이어지는 질문은 **직전 질문이 무엇이었는지** 알아야 답이 자연스럽다
              ? `앞선 질문: ${r.followUp.of}\n이어지는 질문: ${r.question}\n(직전 결과에서 ${r.followUp.filters.join(" · ")} 로 추렸다)\n\n「근거」\n${evidence}`
              : `질문: ${r.question}\n\n「근거」\n${evidence}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      // 오류 본문에 키가 섞여 나올 수 있다. 상태 코드와 사유만 전한다.
      const why = res.status === 401 ? "키가 올바르지 않습니다"
        : res.status === 429 ? "사용량 한도에 걸렸습니다"
        : body.slice(0, 80).replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
      return { text: null, reason: `LLM 호출 실패 (HTTP ${res.status}) — ${why}` };
    }
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) return { text: null, reason: "빈 응답이 왔습니다" };
    return { text, reason: "", model: j.model };
  } catch (e) {
    return { text: null, reason: `LLM 호출 오류 — ${(e as Error).message}` };
  }
}
