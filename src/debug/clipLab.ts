// Dev-only page: play any clip from the animation library on the reference mannequin and on a
// retargeted body side by side, scrub time, attach a prop. Used to check retargeting and to mark
// hit / grab frames. Everything is also scriptable through window.__lab.
import './consoleTap';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bakeClip, type BakedClip } from '../anim/bake';
import { applyPose, Pose, sampleClip } from '../anim/pose';
import { rigFromBones, type Rig } from '../anim/rig';
import { FrameLoop } from '../core/loop';
import { ASSETS, findSkeleton, findSkinnedMeshes, loadClipManifest, loadGLTF, loadSourceClip, loadTexture, type ClipInfo } from '../pieces/assets';

interface LabChar {
  root: THREE.Object3D;
  rig: Rig;
  bones: THREE.Object3D[];
  pose: Pose;
  clip: BakedClip | null;
  pelvis: number;
  props: THREE.Object3D[];
}

const params = new URLSearchParams(location.search);
const bodyName = params.get('body') === 'female' ? 'Female' : 'Male';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1.4, 6.5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x30281e, 0.9));
const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
sun.position.set(3, 6, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -4;
sun.shadow.camera.right = 4;
sun.shadow.camera.top = 4;
sun.shadow.camera.bottom = -4;
sun.shadow.radius = 3;
scene.add(sun);
const rim = new THREE.DirectionalLight(0x88aaff, 1.6);
rim.position.set(-4, 3, -5);
scene.add(rim);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(30, 30, 0x4a5060, 0x343842);
grid.position.y = 0.002;
scene.add(grid);

function makeChar(root: THREE.Object3D, x: number): LabChar {
  const skeleton = findSkeleton(root);
  if (!skeleton) throw new Error('no skeleton');
  const { rig, ordered } = rigFromBones(skeleton.bones);
  for (const m of findSkinnedMeshes(root)) {
    m.frustumCulled = false;
    m.castShadow = true;
    m.receiveShadow = true;
  }
  root.position.x = x;
  scene.add(root);
  return { root, rig, bones: ordered, pose: new Pose(rig.names.length).setRest(rig), clip: null, pelvis: rig.index.get('pelvis') ?? -1, props: [] };
}

const _q = new THREE.Quaternion();

/** Mount a prop in a hand the way the animation library does: grip along model-forward, palm down. */
function mountProp(prop: THREE.Object3D, char: LabChar, side: 'r' | 'l'): void {
  const hand = char.rig.index.get(`hand_${side}`);
  if (hand === undefined) return;
  _q.fromArray(char.rig.restWorldRot, hand * 4).invert();
  const down = new THREE.Vector3(0, -1, 0).applyQuaternion(_q);
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(_q);
  const up = down.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, up);
  prop.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, forward, up));
  prop.position.set(0, 0.09, 0).addScaledVector(down, 0.035);
  if (side === 'l') prop.scale.x = -1;
  char.bones[hand].add(prop);
  char.props.push(prop);
}

const state = {
  time: 0,
  playing: true,
  speed: 1,
  info: null as ClipInfo | null,
  chars: [] as LabChar[],
  manifest: [] as ClipInfo[],
};

const ui = {
  clip: document.getElementById('clip') as HTMLSelectElement,
  time: document.getElementById('time') as HTMLInputElement,
  play: document.getElementById('play') as HTMLButtonElement,
  speed: document.getElementById('speed') as HTMLInputElement,
  prop: document.getElementById('prop') as HTMLSelectElement,
  info: document.getElementById('info') as HTMLDivElement,
};

async function setClip(name: string): Promise<void> {
  const info = state.manifest.find((c) => c.name === name);
  if (!info) throw new Error(`unknown clip ${name}`);
  const source = await loadSourceClip(info);
  const srcRig = state.chars[0].rig;
  for (const c of state.chars) c.clip = bakeClip(source, srcRig, c.rig, { loop: info.loop, name: info.name });
  state.info = info;
  state.time = 0;
  ui.clip.value = name;
}

async function setProp(name: string): Promise<void> {
  for (const c of state.chars) {
    for (const p of c.props) p.removeFromParent();
    c.props.length = 0;
  }
  ui.prop.value = name;
  if (!name || name === 'none') return;
  const gltf = await loadGLTF(`${ASSETS}/props/${name}.glb`);
  for (const c of state.chars) {
    const prop = gltf.scene.clone(true);
    prop.traverse((o) => {
      o.castShadow = true;
    });
    mountProp(prop, c, 'r');
  }
}

function setTime(t: number): void {
  state.time = t;
}

function view(preset: 'front' | 'side' | 'three' | 'top' | 'close'): void {
  const p = {
    front: [0, 1.3, 6.5],
    side: [7, 1.3, 0.001],
    three: [4.2, 1.9, 5.2],
    top: [0.001, 9, 0.001],
    close: [1.1, 1.5, 2.4],
  }[preset];
  camera.position.set(p[0], p[1], p[2]);
  controls.target.set(preset === 'close' ? 1.1 : 0, preset === 'close' ? 1.35 : 1.0, 0);
  controls.update();
}

function update(dt: number): void {
  const clip = state.chars[0]?.clip;
  if (clip) {
    if (state.playing) {
      state.time += dt * state.speed;
      if (state.time > clip.duration) state.time = clip.loop ? state.time % clip.duration : state.time > clip.duration + 0.6 ? 0 : state.time;
    }
    const t = Math.min(state.time, clip.duration);
    for (const c of state.chars) {
      if (!c.clip) continue;
      sampleClip(c.clip, t, c.pose);
      applyPose(c.pose, c.bones, c.pelvis);
      const baseX = c === state.chars[0] ? -1.1 : 1.1;
      c.root.position.set(baseX + c.pose.rootMotion[0], c.pose.rootMotion[1], c.pose.rootMotion[2]);
    }
    if (document.activeElement !== ui.time) ui.time.value = String(t / clip.duration);
    ui.info.textContent =
      `${clip.name}\n` +
      `t ${t.toFixed(3)} / ${clip.duration.toFixed(3)} s   frame ${(t * clip.fps).toFixed(1)} / ${clip.frames - 1}\n` +
      `${clip.loop ? 'loop' : 'once'}${clip.rootMotion ? '  root-motion' : ''}  tags: ${state.info?.tags.join(',') ?? ''}`;
  }
  controls.update();
  renderer.render(scene, camera);
}

async function init(): Promise<void> {
  const [manifest, mannequin, hero, normal] = await Promise.all([
    loadClipManifest(),
    loadGLTF(`${ASSETS}/models/m2m-human.glb`),
    loadGLTF(`${ASSETS}/models/superhero/Superhero_${bodyName}_FullBody.gltf`),
    loadTexture(`${ASSETS}/models/superhero/T_Superhero_${bodyName}_Normal.png`, { flipY: false }),
  ]);
  state.manifest = manifest;

  const clay = new THREE.MeshStandardMaterial({ color: 0xd8d2c8, roughness: 0.5, metalness: 0, normalMap: normal });
  const plain = new THREE.MeshStandardMaterial({ color: 0xd8d2c8, roughness: 0.5 });
  for (const m of findSkinnedMeshes(hero.scene)) {
    const name = (m.material as THREE.Material).name;
    m.material = /Superhero/i.test(name) ? clay : plain;
  }

  state.chars = [makeChar(mannequin.scene, -1.1), makeChar(hero.scene, 1.1)];

  const sorted = [...manifest].sort((a, b) => a.name.localeCompare(b.name));
  for (const c of sorted) {
    const o = document.createElement('option');
    o.value = c.name;
    o.textContent = `${c.name}  (${c.duration.toFixed(2)}s${c.loop ? ' L' : ''})`;
    ui.clip.appendChild(o);
  }
  for (const p of ['none', 'sword_A', 'sword_B', 'sword_C', 'sword_E', 'odache', 'hammer_B', 'staff_B', 'spear_A', 'halberd', 'dagger_A']) {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p;
    ui.prop.appendChild(o);
  }

  ui.clip.onchange = () => void setClip(ui.clip.value);
  ui.prop.onchange = () => void setProp(ui.prop.value);
  ui.time.oninput = () => {
    const clip = state.chars[0].clip;
    if (clip) state.time = Number(ui.time.value) * clip.duration;
    state.playing = false;
    ui.play.textContent = 'play';
  };
  ui.play.onclick = () => {
    state.playing = !state.playing;
    ui.play.textContent = state.playing ? 'pause' : 'play';
  };
  ui.speed.onchange = () => (state.speed = Number(ui.speed.value));

  await setClip(params.get('clip') ?? 'Idle_Sword');
  if (params.get('prop')) await setProp(params.get('prop')!);

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  const loop = new FrameLoop((dt) => update(dt));
  loop.targetFps = 60;
  loop.start();
}

const ready = init();
ready.catch((err) => {
  console.error(err);
  ui.info.textContent = String(err);
});

const lab = {
  ready,
  setClip,
  setProp,
  setTime,
  view,
  play: () => {
    state.playing = true;
  },
  pause: () => {
    state.playing = false;
  },
  /** Jump to a clip and time, paused: for screenshots. */
  async show(clip: string, t = 0, prop?: string): Promise<void> {
    await ready;
    if (state.info?.name !== clip) await setClip(clip);
    if (prop !== undefined) await setProp(prop);
    state.playing = false;
    state.time = t;
  },
  clips: () => state.manifest.map((c) => c.name),
  /**
   * Weapon-tip analysis on the retargeted body: where the tip of the right-hand prop is over
   * the clip, and the moments it moves fastest (candidate hit times), in model space.
   */
  tipTrack(samples = 120): unknown {
    const c = state.chars[1];
    const clip = c.clip;
    const prop = c.props[0];
    if (!clip || !prop) return null;
    let tipY = 0.5;
    prop.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.computeBoundingBox();
        tipY = Math.max(tipY, m.geometry.boundingBox!.max.y);
      }
    });
    const base = c.root.position.clone();
    const tip = new THREE.Vector3();
    const pts: { t: number; x: number; y: number; z: number; v: number }[] = [];
    let prev: THREE.Vector3 | null = null;
    const dt = clip.duration / samples;
    for (let i = 0; i <= samples; i++) {
      const t = i * dt;
      sampleClip(clip, t, c.pose);
      applyPose(c.pose, c.bones, c.pelvis);
      c.root.position.copy(base);
      c.root.updateMatrixWorld(true);
      tip.set(0, tipY, 0);
      prop.localToWorld(tip).sub(base);
      const v: number = prev ? tip.distanceTo(prev) / dt : 0;
      pts.push({ t: +t.toFixed(3), x: +tip.x.toFixed(2), y: +tip.y.toFixed(2), z: +tip.z.toFixed(2), v: +v.toFixed(1) });
      prev = tip.clone();
    }
    // Peaks of tip speed.
    const peaks = pts.filter((p, i) => i > 1 && i < pts.length - 1 && p.v > pts[i - 1].v && p.v >= pts[i + 1].v && p.v > 4);
    const reach = pts.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.z)), 0);
    return { clip: clip.name, duration: +clip.duration.toFixed(2), tipLength: +tipY.toFixed(2), maxReach: +reach.toFixed(2), peaks: peaks.map((p) => `t=${p.t} v=${p.v} tip=(${p.x},${p.y},${p.z})`) };
  },
  /** Place the camera at (px,py,pz) looking at (tx,ty,tz). */
  look(px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov = 35): void {
    camera.position.set(px, py, pz);
    controls.target.set(tx, ty, tz);
    camera.fov = fov;
    camera.updateProjectionMatrix();
    controls.update();
  },
  state,
  scene,
  camera,
  renderer,
};
(window as unknown as { __lab: typeof lab }).__lab = lab;
