/**
 * 3D 배치 계산 — 순수 함수. three.js 에 의존하지 않는다.
 *
 * ── 축을 무엇으로 쓸 것인가 ──────────────────────────────────────────
 * law-navigator 에서는 Y 가 **법령 계층**이었다(법률 → 시행령 → 고시).
 * 데이터에 이미 있던 계층을 축에 맞춘 것이지, 입체를 만들려고 쓴 게 아니었다.
 *
 * 영화에는 그런 계층이 없다. 대신 **홉 거리**가 있다 —
 * 질문에서 출발해 인물을 몇 번 건넜는가. 그것이 이 프로젝트의 동작 그 자체이므로
 * Y 를 홉 거리로 쓴다. 씨앗이 맨 위, 건널수록 아래로 내려간다.
 *
 * 한국/외국은 **색**으로 나눈다. 국경을 넘는 다리는 색이 바뀌는 선으로 보인다.
 */

export const HOP_GAP = 30;
export const HOP_LABEL = ["출발점", "1다리 건넘", "2다리 건넘", "3다리 건넘"];

export const hopY = (hop: number): number => -hop * HOP_GAP;

export interface Placed {
  id: string;
  hop: number;
  x: number;
  y: number;
  z: number;
}

/**
 * 집중형 — 질문 결과 10~15개.
 * 홉마다 한 줄로 늘어놓되 가운데를 기준으로 좌우 대칭이 되게 한다.
 */
export function placeFocus(items: { id: string; hop: number }[], spread = 24): Placed[] {
  const byHop = new Map<number, string[]>();
  for (const it of items) {
    if (!byHop.has(it.hop)) byHop.set(it.hop, []);
    byHop.get(it.hop)!.push(it.id);
  }
  const out: Placed[] = [];
  for (const [hop, ids] of byHop) {
    const n = ids.length;
    ids.forEach((id, i) => {
      const perRow = Math.min(n, 5);
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const rowN = Math.min(perRow, n - row * perRow);
      out.push({
        id, hop,
        x: (col - (rowN - 1) / 2) * spread,
        y: hopY(hop),
        z: row * spread * 0.8 - (Math.ceil(n / perRow) - 1) * spread * 0.4,
      });
    });
  }
  return out;
}

/**
 * 전경형 — 말뭉치 전체를 배경으로.
 * 황금각 나선이라 **새로고침해도 자리가 같다** (작품의 위치가 기억되는 편이 읽기에 낫다).
 * 한국 작품은 위쪽 원판, 외국 작품은 아래쪽 원판에 둔다 — 국경이 층으로 보인다.
 */
export function placeField(items: { id: string; korean: boolean }[], radius = 150): Placed[] {
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const out: Placed[] = [];
  for (const [layer, korean] of [[0, true], [1, false]] as [number, boolean][]) {
    const list = items.filter((x) => x.korean === korean);
    const n = list.length;
    list.forEach((it, i) => {
      const t = n === 1 ? 0 : i / (n - 1);
      const r = radius * Math.sqrt(t);
      const a = i * GOLDEN;
      out.push({ id: it.id, hop: layer, x: Math.cos(a) * r, y: hopY(layer * 1.6), z: Math.sin(a) * r });
    });
  }
  return out;
}
