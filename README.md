# 그래프 네비게이터

**하나의 GraphRAG 엔진에 두 도메인** — 🎬 영화와 🏛 인물(한국사).
흩어진 문서에서 관계를 뽑아 지식 그래프로 쌓고, **한 문서만 읽어서는 답이 안 나오는 질문**에
**근거와 탄 경로를 함께** 붙여 답합니다.

**▶ [graph-navigator-kr.vercel.app](https://graph-navigator-kr.vercel.app)**
— 답변 문장을 보려면 우측 상단 **설정**에서 OpenAI 키를 넣으세요.
키 없이도 **근거·탄 경로·삼중항·출처·3D 는 전부** 나옵니다.

> 모두의연구소 AGENT01 · 「7. 영화 추천 에이전트 만들기」 프로젝트 제출물
> 상세 측정과 실패 분석은 **[REPORT.md](REPORT.md)** 를 보세요.

---

## 왜 그래프인가

두 도메인 모두 **키워드 검색이 원리적으로 못 푸는 질문**이 있습니다.

```
🎬  "송강호와 이선균이 함께 출연한 영화는?"

    《기생충》 줄거리: "전원 백수로 살 길 막막하지만 사이는 좋은 기택 가족…"
    → '송강호' 도 '이선균' 도 한 글자도 없다

    답이 있는 문서에 질문의 단어가 하나도 없으므로 BM25 는 그 문서에 닿을 수 없다.
    두 사람의 출연 목록을 각각 펼쳐 **겹치는 곳**을 봐야 답이 나온다.
```

```
🏛  "김규식이 파리강화회의 대표로 파견된 단체에 함께 속했던 인물은?"

    김규식 ─소속─▶ 신한청년당 ◀─소속─ 김구
              (다리)
```

**다만 인물 도메인에서는 이 우위가 항상 서지 않습니다.** 위키백과 인물 문서는 그 인물의
관계를 자기 안에 다 적기 때문입니다. 어디서 서고 어디서 안 서는지를 숫자로 갈라
REPORT 에 실었습니다.

---

## 두 도메인

| | 🎬 영화 | 🏛 인물 (한국사) |
|---|---|---|
| 출처 | TMDB — **이미 구조화된** 크레딧 | 위키백과 **산문** |
| 규모 | 작품 3,072 (한국 2,212 · 외국 860) · 인물 27,282 · 관계 63,530 | 문서 140 · 노드 1,135 · 관계 1,620 · 근거 문장 2,183 |
| 관계 추출 | **규칙** (크레딧이 곧 관계) | **LLM** + 근거 문장 원문 대조 |
| 정제·병합 | 거의 불필요 (TMDB 가 이미 정규화) | 호(號)·표기·관직·동명이인 — **전부 필요** |
| 다리 | 인물 (작품↔작품) | 인물·조직·사건이 서로 다리 |
| 골든셋 | 152문항 (홀드아웃 100 포함) | 52문항 (홉별·시대별·거절·bridge-hard) |

**같은 엔진, 다른 도메인.** 질의 파이프라인은 하나의 LangGraph `StateGraph` 이고
노드 구현만 도메인이 주입합니다 (§ [REPORT — 파이프라인 구조도](REPORT.md#4-파이프라인-구조도)).

---

## 화면

네 화면이 도메인마다 대칭으로 있습니다. 상단 탭으로 도메인을 바꾸면 **메뉴가 통째로 바뀝니다.**

| 화면 | 영화 | 인물 |
|---|---|---|
| 질문 | `/` | `/history` |
| 탐색기 | `/browse` | `/history/browse` |
| 지도 | `/map` | `/history/map` |
| 3D | 오른쪽 붙박이 — 도메인에 따라 데이터·범례가 바뀝니다 | |

**🏛 인물 — 질문 하나에 답변·탄 경로·삼중항·출처, 그리고 3D 에 그려진 길**

![인물 질문 화면](docs/screenshots/history-ask.png)

**🎬 영화 — 같은 뼈대, 다른 도메인**

![영화 질문 화면](docs/screenshots/movie-ask.png)

**한 화면에 반드시 같이 뜨는 것** — 답변 · **탄 경로** · **근거 삼중항** · **출처 문서**.
답변만 보이면 무엇을 근거로 한 말인지 알 수 없고, 그러면 이 도구를 쓸 이유가 없습니다.

3D 에서 노드를 클릭하면 영화는 **포스터**, 인물은 **근거 카드**(위키백과 본문 + 삼중항 + 원문 링크)가 뜹니다.

---

## 실행

### 필요한 것

- **Node.js 24 이상** (`engines` 에 명시)
- pnpm (corepack 으로 자동)
- OpenAI 키는 **선택** — 없어도 근거·경로·삼중항·출처·3D 는 전부 동작합니다

### 바로 띄우기

```bash
git clone https://github.com/GojoSuperman/graph-navigator.git
cd graph-navigator
corepack pnpm install
corepack pnpm build && corepack pnpm start     # http://localhost:3000
```

**수집·추출을 다시 돌릴 필요가 없습니다.** 코퍼스와 그래프, 평가 결과를 전부 커밋해
두었습니다 — 채점자에게 위키 API 140건과 LLM 추출을 다시 돌리게 할 수는 없습니다.

```
data/           영화 그래프 · 골든셋 152문항
data/history/   문서 140건 · 그래프 · 골든셋 52문항 · 추출 원본(v1·v2)
output/history/ 평가 결과 · 질의 로그(runs.jsonl) · 스윕 결과
```

### 답변 문장까지 보려면

우측 상단 **설정**에서 OpenAI 키를 넣습니다. 키는 **브라우저에만** 저장되고 서버로
가지 않습니다. 로컬 개발에서는 `.env.local` 로도 됩니다.

```bash
cp .env.example .env.local     # OPENAI_API_KEY=sk-... 를 채운다
corepack pnpm dev
```

> 배포본은 **서버 키를 폴백으로 쓰지 않습니다.** 공개된 순간 남의 지갑으로 모델이 돌아갑니다.

---

## 파이프라인 다시 돌리기 (선택)

```bash
# 🏛 인물 — 1단계부터
pnpm history:fetch      # 위키백과 수집 (시드 43건 → 문서 140건, 약 10분)
pnpm history:density    # 1.5 밀도 게이트 — 미달이면 여기서 멈춘다
pnpm history:extract    # LLM 관계 추출 (647조각, 약 10분, $1.6)   ← 키 필요
pnpm history:graph      # 정제·병합 → graph.json
pnpm history:ask "안창호가 세운 조직은?"

# 🎬 영화
pnpm fetch && pnpm awards && pnpm graph
pnpm ask "송강호와 이선균이 함께 출연한 영화는?"

# 평가 (LLM 0회)
node scripts/history/evaluate.ts     # 홉별·시대별·BM25 대조·실패 3층
node scripts/evaluate.ts             # 영화
pnpm test                            # 단위 테스트 73건
```

---

## 구조

```
lib/
  pipeline.ts          두 도메인 공통 LangGraph StateGraph
  domains/history.ts   인물 도메인의 노드 구현
  ask.ts · route.ts    영화 도메인의 탐색 (아직 공통 그래프로 안 올림)
  history/
    config.ts          도메인에 묶인 값 (노드·관계·홉·허브·예산)
    graph.ts           그래프 적재 + n홉 탐색 + **경로 기록**
    answer.ts          답변 생성 (LLM 이 있는 유일한 자리)
scripts/history/
  fetch-wiki.ts        수집 (429·네트워크 백오프 · 이어받기)
  density.ts           1.5 밀도 게이트
  extract.ts           LLM 추출 + 근거 원문 대조 + 타입 서명 대조
  build-graph.ts       정제·병합 (호 병합 · 관직 제외 · 중복 제거)
  sweep.ts             홉·허브 실측 스윕
  evaluate.ts          평가 (LLM 0회)
  evaluate-answer.ts   답변 정확도 (3층)
app/
  history/{page,browse/page,map/page}.tsx
  api/history/{ask,focus,graph,node}/route.ts
docs/
  설계서.md            설계와 그 근거 (예상이 틀린 자리를 지우지 않고 남김)
  실패 정독.md          대표 실패 5건을 손으로 읽은 기록
```

---

## 이 프로젝트가 지킨 것

- **근거가 없으면 답하지 않습니다.** 범위 밖이면 LLM 을 **호출하지도** 않습니다 — 호출하지 않으면 지어낼 기회 자체가 없습니다.
- **탄 경로를 기록하고 함께 보여 줍니다.** 답이 맞아도 경로가 없으면 증명이 안 됩니다.
- **평가에 LLM 을 거의 쓰지 않습니다.** 컨텍스트·경로 재현율은 호출 0회라 하루에 몇 번이고 다시 잽니다.
- **예상이 틀린 자리를 지우지 않습니다.** 설계서와 REPORT 에 전후를 나란히 남겼습니다.

## 데이터 출처

- 🎬 [TMDB](https://www.themoviedb.org/) — 이 제품은 TMDB API 를 쓰지만 TMDB 가 인증하거나 보증하지 않습니다.
- 🏛 [한국어 위키백과](https://ko.wikipedia.org/) — CC BY-SA 4.0. 수집은 MediaWiki API 만 사용했고 HTML 크롤링은 하지 않았습니다.
