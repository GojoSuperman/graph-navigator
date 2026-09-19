/**
 * 3D 씬 — 브라우저 전용. three.js 를 여기에만 가둔다.
 *
 *   focus — 질문 결과만 띄운다. Y 가 **홉 거리**다
 *   field — 말뭉치를 배경에 깔고 경로만 점화한다
 *
 * ── 이 화면이 보여 주려는 것 ─────────────────────────────────────────
 * 선 위에 뜨는 이름이 **다리의 정체**다. 《기생충》과 《부산행》 사이에는
 * 어떤 공통 어휘도 없지만 '최우식' 이라는 사람을 거치면 이어진다.
 * 그래서 엣지 라벨을 노드 라벨만큼 중요하게 다룬다 — 법령판에서 '위임' 이라고
 * 적었던 자리에, 여기서는 사람 이름이 들어간다.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { HOP_LABEL, HOP_GAP, hopY, boundsOf, placeField, placeFocus, type Placed } from "@/lib/viz.ts";

export interface VizNode { id: string; label: string; hop: number; korean: boolean; isSeed: boolean; poster?: string | null; year?: number | null }
export interface VizEdge { from: string; to: string; via: string }
export interface VizInput { nodes: VizNode[]; edges: VizEdge[]; refused: boolean }
export interface FieldData { nodes: { id: string; title: string; korean: boolean }[] }

export interface SceneApi {
  show(input: VizInput | null): void;
  resize(): void;
  dispose(): void;
}

const KO = 0x64b5ff;     // 한국 작품
const FOREIGN = 0xffb86b; // 외국 작품
const BRIDGE = 0x7ee787;  // 다리(선)

const reduceMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function createScene(
  host: HTMLElement,
  mode: "focus" | "field",
  field: FieldData | null,
  /** 노드를 누르면 알려 준다 — 포스터 모달을 띄우는 쪽에서 받는다 */
  onPick?: (n: VizNode) => void,
): SceneApi {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d12);
  scene.fog = new THREE.Fog(0x0b0d12, 200, 520);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  camera.position.set(mode === "field" ? 190 : 80, 46, mode === "field" ? 190 : 110);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  host.appendChild(renderer.domElement);

  // 한글 라벨은 WebGL 이 직접 못 그린다. DOM 을 3D 좌표에 얹는다.
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = "viz-labels";
  host.appendChild(labelRenderer.domElement);

  const controls = new OrbitControls(camera, labelRenderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, -HOP_GAP * 0.8, 0);

  /**
   * 확대하면 라벨도 같이 커진다 (최대 2배).
   *
   * CSS2DRenderer 는 라벨의 transform 을 직접 쓰므로 scale() 을 덧씌울 수 없다.
   * 대신 컨테이너에 CSS 변수를 꽂고 글자 크기·여백이 그 값을 따르게 한다.
   * 기준은 처음 카메라 거리 — 가까워진 비율만큼 키우되 1~2배로 묶는다
   * (축소할 때까지 작아지면 멀리서 아무것도 안 읽힌다).
   */
  const baseDistance = camera.position.distanceTo(controls.target);
  let lastZoom = -1;

  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(60, 120, 80);
  scene.add(key);

  // ── 층 바닥 ────────────────────────────────────────────────────────
  const layers = new THREE.Group();
  const half = mode === "field" ? 180 : 58;
  const levels = mode === "field" ? ["🇰🇷 한국 작품", "해외 작품"] : HOP_LABEL.slice(0, 3);
  levels.forEach((name, i) => {
    const y = mode === "field" ? hopY(i * 1.6) : hopY(i);
    const grid = new THREE.GridHelper(half * 2, mode === "field" ? 18 : 8, 0x232a36, 0x232a36);
    grid.position.y = y;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.25;
    layers.add(grid);
    const el = document.createElement("div");
    el.className = "viz-tier";
    el.textContent = name;
    const tag = new CSS2DObject(el);
    tag.position.set(-half, y + 3, -half);
    layers.add(tag);
  });
  scene.add(layers);

  // ── 배경 (field) ───────────────────────────────────────────────────
  const pos = new Map<string, Placed>();
  if (mode === "field" && field) {
    for (const p of placeField(field.nodes)) pos.set(p.id, p);
    const geo = new THREE.BufferGeometry();
    const arr = new Float32Array(field.nodes.length * 3);
    const col = new Float32Array(field.nodes.length * 3);
    field.nodes.forEach((n, i) => {
      const p = pos.get(n.id)!;
      arr.set([p.x, p.y, p.z], i * 3);
      const c = new THREE.Color(n.korean ? KO : FOREIGN).multiplyScalar(0.3);
      col.set([c.r, c.g, c.b], i * 3);
    });
    geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ size: 2.4, vertexColors: true })));
  }

  // ── 점화되는 것들 ──────────────────────────────────────────────────
  const live = new THREE.Group();
  scene.add(live);
  type Anim = { mesh?: THREE.Mesh; line?: THREE.Line; a: THREE.Vector3; b: THREE.Vector3; at: number };
  let anims: Anim[] = [];
  /**
   * 선을 따라 흐르는 빛.
   *
   * 선이 한 번 그려지고 멈추면 **다리가 정지한 그림**이 된다.
   * 작은 빛이 계속 흘러가면 "이쪽에서 저쪽으로 건넌다" 는 방향이 눈에 남는다.
   * 선 자체를 애니메이션하는 대신(매 프레임 정점 갱신) 구 하나를 굴린다 — 더 싸다.
   */
  type Pulse = { mesh: THREE.Mesh; a: THREE.Vector3; b: THREE.Vector3; offset: number; at: number };
  let pulses: Pulse[] = [];
  let t0 = 0;

  function clear() {
    picks.length = 0;
    pulses = [];
    for (const o of [...live.children]) {
      live.remove(o);
      o.traverse?.((c) => {
        const m = c as THREE.Mesh;
        // sphere·pulseGeo 는 모든 노드가 공유한다. 여기서 버리면 다음 질문에서 터진다.
        if (m.geometry !== sphere && m.geometry !== pulseGeo) m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      if ((o as CSS2DObject).element) (o as CSS2DObject).element.remove();
    }
    anims = [];
  }

  const sphere = new THREE.SphereGeometry(1, 20, 16);
  const pulseGeo = new THREE.SphereGeometry(1.15, 10, 8);

  /** 지금 화면에 맞춰야 할 범위 */
  let fitted: ReturnType<typeof boundsOf> | null = null;

  /**
   * 카메라를 배치에 **꽉 차게** 맞춘다.
   *
   * 처음엔 거리에 임의의 배수(2.6)를 곱했다가 필요한 거리의 다섯 배쯤 물러나
   * 그래프가 가운데 점처럼 작게 보였다. 제대로 계산한다 —
   * 반경 r 이 시야에 들어오려면 거리는 r / tan(시야각/2) 다.
   *
   * 패널은 세로로 길쭉해서 **가로가 먼저 잘린다.** 세로·가로 중
   * 더 먼 쪽을 택해야 어느 쪽도 화면 밖으로 나가지 않는다.
   */
  function fitCamera() {
    if (!fitted) return;
    const target = new THREE.Vector3(fitted.center.x, fitted.center.y, fitted.center.z);
    const vfov = (camera.fov * Math.PI) / 180;
    const distV = fitted.radius / Math.tan(vfov / 2);
    const distH = fitted.radius / Math.tan(Math.atan(Math.tan(vfov / 2) * camera.aspect));
    const dist = Math.max(distV, distH) * 1.15 + 8;   // 여백 15% + 라벨 자리
    const dir = new THREE.Vector3(0.4, 0.36, 1).normalize();
    camera.position.copy(target).addScaledVector(dir, dist);
    controls.target.copy(target);
    controls.update();
  }
  /** 화면에 떠 있는 노드 — 클릭 판정에 쓴다 */
  const picks: { mesh: THREE.Mesh; node: VizNode }[] = [];

  function show(input: VizInput | null) {
    clear();
    if (!input || input.refused || !input.nodes.length) return;

    const local = new Map<string, Placed>();
    if (mode === "field") {
      for (const n of input.nodes) if (pos.has(n.id)) local.set(n.id, pos.get(n.id)!);
      // 배경에 없는 작품(인기 밖)은 focus 배치로 보충한다
      const missing = input.nodes.filter((n) => !local.has(n.id));
      for (const p of placeFocus(missing.map((n) => ({ id: n.id, hop: n.hop })))) local.set(p.id, p);
    } else {
      for (const p of placeFocus(input.nodes.map((n) => ({ id: n.id, hop: n.hop })))) local.set(p.id, p);
    }

    const STEP = reduceMotion() ? 0 : 0.3;
    const arrivalAt = new Map<string, number>();
    for (const n of input.nodes) if (n.isSeed) arrivalAt.set(n.id, 0);

    // 선 — 씨앗에서 뻗어 나간다. 선 위의 이름이 다리다.
    const pending = [...input.edges];
    let guard = 0;
    while (pending.length && guard++ < 40) {
      const ready = pending.filter((e) => arrivalAt.has(e.from));
      if (!ready.length) break;
      for (const e of ready) {
        pending.splice(pending.indexOf(e), 1);
        const a = local.get(e.from), b = local.get(e.to);
        const start = arrivalAt.get(e.from)! + STEP * 0.4;
        if (!a || !b) continue;
        const va = new THREE.Vector3(a.x, a.y, a.z);
        const vb = new THREE.Vector3(b.x, b.y, b.z);
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([va, va.clone()]),
          new THREE.LineBasicMaterial({ color: BRIDGE, transparent: true, opacity: 0.9 }),
        );
        live.add(line);
        anims.push({ line, a: va, b: vb, at: start });

        if (!reduceMotion()) {
          const dot = new THREE.Mesh(
            pulseGeo,
            new THREE.MeshBasicMaterial({ color: BRIDGE, transparent: true, opacity: 0.95 }),
          );
          dot.visible = false;
          live.add(dot);
          // 선마다 시작점을 어긋나게 해 한꺼번에 몰려가지 않게 한다
          pulses.push({ mesh: dot, a: va, b: vb, offset: (pulses.length * 0.37) % 1, at: start + STEP });
        }

        // 다리 이름 — 선 한가운데
        if (e.via) {
          const el = document.createElement("div");
          el.className = "viz-via";
          el.textContent = e.via;
          el.style.opacity = "0";
          el.dataset.at = String(start + STEP * 0.6);
          const tag = new CSS2DObject(el);
          tag.position.copy(va.clone().add(vb).multiplyScalar(0.5));
          live.add(tag);
        }

        const done = start + STEP;
        if (!arrivalAt.has(e.to) || arrivalAt.get(e.to)! > done) arrivalAt.set(e.to, done);
      }
    }

    for (const n of input.nodes) {
      const p = local.get(n.id);
      if (!p) continue;
      const color = n.korean ? KO : FOREIGN;
      const mesh = new THREE.Mesh(
        sphere,
        new THREE.MeshStandardMaterial({
          color, emissive: color, emissiveIntensity: n.isSeed ? 0.75 : 0.35, roughness: 0.4,
        }),
      );
      mesh.position.set(p.x, p.y, p.z);
      mesh.scale.setScalar(0.001);
      live.add(mesh);
      picks.push({ mesh, node: n });
      anims.push({ mesh, a: new THREE.Vector3(n.isSeed ? 4.4 : 3.2, 0, 0), b: new THREE.Vector3(), at: arrivalAt.get(n.id) ?? 0 });

      const el = document.createElement("div");
      el.className = n.isSeed ? "viz-label seed" : "viz-label";
      el.textContent = n.label;
      el.style.opacity = "0";
      el.dataset.at = String(arrivalAt.get(n.id) ?? 0);
      const tag = new CSS2DObject(el);
      tag.position.set(p.x, p.y + 5.5, p.z);
      live.add(tag);
    }

    fitted = boundsOf([...local.values()]);
    fitCamera();

    t0 = performance.now() / 1000;
  }

  // ── 고르기 ─────────────────────────────────────────────────────────
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hovered: THREE.Mesh | null = null;

  function hit(ev: PointerEvent) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    const found = ray.intersectObjects(picks.map((p) => p.mesh), false)[0];
    return found ? picks.find((p) => p.mesh === found.object) ?? null : null;
  }

  let downAt = 0;
  const onDown = () => { downAt = performance.now(); };
  const onUp = (ev: PointerEvent) => {
    // 끌어서 회전한 것과 구분한다 — 짧게 누른 것만 선택으로 본다
    if (performance.now() - downAt > 250) return;
    const p = hit(ev);
    if (p) onPick?.(p.node);
  };
  const onMove = (ev: PointerEvent) => {
    const p = hit(ev);
    const next = p?.mesh ?? null;
    if (next === hovered) return;
    if (hovered) hovered.scale.multiplyScalar(1 / 1.35);
    hovered = next;
    if (hovered) hovered.scale.multiplyScalar(1.35);
    renderer.domElement.style.cursor = hovered ? "pointer" : "";
  };
  const surface = labelRenderer.domElement;
  surface.addEventListener("pointerdown", onDown);
  surface.addEventListener("pointerup", onUp);
  surface.addEventListener("pointermove", onMove);

  let raf = 0;
  const tmp = new THREE.Vector3();
  function loop() {
    raf = requestAnimationFrame(loop);
    const now = performance.now() / 1000 - t0;
    for (const an of anims) {
      const k = Math.min(1, Math.max(0, (now - an.at) / 0.34));
      const e = 1 - Math.pow(1 - k, 3);
      if (an.line) {
        tmp.lerpVectors(an.a, an.b, e);
        const arr = an.line.geometry.attributes.position as THREE.BufferAttribute;
        arr.setXYZ(1, tmp.x, tmp.y, tmp.z);
        arr.needsUpdate = true;
      } else if (an.mesh) {
        an.mesh.scale.setScalar(Math.max(0.001, an.a.x * e));
      }
    }
    // 흐르는 빛 — 선을 다 그린 뒤부터 반복해서 건너간다
    for (const p of pulses) {
      if (now < p.at) { p.mesh.visible = false; continue; }
      p.mesh.visible = true;
      const t = ((now - p.at) * 0.42 + p.offset) % 1;
      p.mesh.position.lerpVectors(p.a, p.b, t);
      // 양 끝에서 사그라들게 — 갑자기 나타났다 사라지면 눈에 거슬린다
      const fade = Math.sin(t * Math.PI);
      p.mesh.scale.setScalar(0.35 + fade * 0.85);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.25 + fade * 0.7;
    }

    for (const o of live.children) {
      const el = (o as CSS2DObject).element;
      if (!el || el.dataset?.at === undefined) continue;
      const k = Math.min(1, Math.max(0, (now - Number(el.dataset.at) - 0.15) / 0.3));
      el.style.opacity = String(k);
    }
    controls.update();

    const z = Math.min(2, Math.max(1, baseDistance / Math.max(camera.position.distanceTo(controls.target), 1)));
    if (Math.abs(z - lastZoom) > 0.01) {
      labelRenderer.domElement.style.setProperty("--viz-zoom", z.toFixed(2));
      lastZoom = z;
    }

    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }
  loop();

  function resize() {
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    fitCamera();   // 폭이 바뀌면 잘리는 쪽도 바뀐다
  }
  resize();

  return {
    show, resize,
    dispose() {
      surface.removeEventListener("pointerdown", onDown);
      surface.removeEventListener("pointerup", onUp);
      surface.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(raf);
      clear();
      sphere.dispose();
      pulseGeo.dispose();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labelRenderer.domElement.remove();
    },
  };
}
