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

    // 하나뿐이면 가운데
    if (n === 1) {
      out.push({ id: ids[0], hop, x: 0, y: hopY(hop), z: 0 });
      continue;
    }

    /**
     * **원둘레에 고르게 놓는다.**
     *
     * 한 줄로 늘어놓던 방식은 한 홉에 열 개가 몰리면 구와 라벨이 겹쳤다
     * ("A·B·C에 모두 출연한 배우" 같은 질문에서 실제로 그랬다).
     * 원형은 이웃 간 거리가 개수와 무관하게 일정해지고, 반지름만 늘리면
     * 아무리 많아도 겹치지 않는다. 힘 기반 배치와 달리 계산이 없고
     * **새로고침해도 자리가 같다** — 위치가 기억되는 편이 읽기에 낫다.
     */
    const radius = Math.max(spread, (n * spread) / (2 * Math.PI));
    ids.forEach((id, i) => {
      // 홉마다 조금씩 돌려 위아래 노드가 세로로 포개지지 않게 한다
      const a = (i / n) * Math.PI * 2 + hop * 0.4;
      out.push({ id, hop, x: Math.cos(a) * radius, y: hopY(hop), z: Math.sin(a) * radius });
    });
  }
  return out;
}

/** 배치의 중심과 크기 — 카메라를 여기에 맞춘다 */
export function boundsOf(ps: Placed[]) {
  if (!ps.length) return { center: { x: 0, y: 0, z: 0 }, radius: 40 };
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of ps) {
    min.x = Math.min(min.x, p.x); max.x = Math.max(max.x, p.x);
    min.y = Math.min(min.y, p.y); max.y = Math.max(max.y, p.y);
    min.z = Math.min(min.z, p.z); max.z = Math.max(max.z, p.z);
  }
  const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
  const radius = Math.max(
    Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2,
    30,
  );
  return { center, radius };
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
