// Game entry point: builds the hall, the statues and the interface, then runs the frame loop.
import './debug/consoleTap';
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { ALL_CLIPS } from './anim/clips';
import { analyzeGait, type Gait } from './anim/gait';
import { GameAudio } from './audio/audio';
import { ChessGame } from './chess/game';
import { CameraRig } from './cinema/cameraRig';
import { Cinema } from './cinema/cinema';
import { FrameLoop } from './core/loop';
import { warmUp } from './core/warmup';
import { installDebugApi } from './debug/api';
import { GpuTimer, PerfRecorder } from './debug/perf';
import { Effects } from './fx/effects';
import { Physics } from './fx/physics';
import { ShatterSystem } from './fx/shatter';
import { BOARD_HALF } from './game/squares';
import { GameController } from './game/controller';
import { Picker } from './input/picker';
import { ASSETS } from './pieces/assets';
import { Cast } from './pieces/cast';
import { loadChessSet } from './pieces/regalia';
import { StatueKit, type BodyKind } from './pieces/statueKit';
import { createTiles, loadBoardMaterials, TILE_HEIGHT } from './render/board';
import { createHall, createTraceryCookie, FLOOR_Y } from './render/hall';
import { createLightRig } from './render/lighting';
import { Markers } from './render/markers';
import { DEFAULT_LOOK, Pipeline } from './render/pipeline';
import { BoardReflection } from './render/reflection';
import { ATTACK_CLIPS } from './sequence/attacks';
import { SPECIAL_CLIPS } from './sequence/special';
import { Director } from './sequence/director';
import { Hud, LoadingScreen } from './ui/hud';

async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  const loading = new LoadingScreen(document.body);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06080e);
  scene.fog = new THREE.FogExp2(0x06080e, 0.03);
  const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.2, 150);

  const pipeline = new Pipeline(scene, camera, app);
  // Resizing clears the canvas, so redraw at once if the loop is not running (manual stepping).
  let redraw: (() => void) | null = null;
  let reflection: BoardReflection | null = null;
  const fit = (): void => {
    pipeline.setSize(innerWidth, innerHeight, Math.min(devicePixelRatio, 2));
    const size = pipeline.renderSize;
    reflection?.setSize(size.width, size.height);
    redraw?.();
  };
  fit();
  addEventListener('resize', fit);
  pipeline.applyLook(DEFAULT_LOOK);

  // Load everything in parallel, reporting coarse progress.
  let done = 0;
  const steps = 6;
  const track = <T>(label: string, p: Promise<T>): Promise<T> =>
    p.then((v) => {
      done++;
      loading.progress(done / (steps + 1), label);
      return v;
    });
  const [kit, chess, boardMaterials, hall, hdr, physics] = await Promise.all([
    track('Carving the statues', StatueKit.load()),
    track('Setting the pieces', loadChessSet()),
    track('Laying the board', loadBoardMaterials()),
    track('Raising the hall', createHall()),
    track('Lighting the braziers', new HDRLoader().loadAsync(`${ASSETS}/hdr/sepulchral_chapel_basement_2k.hdr`)),
    track('Weighing the stone', Physics.create()),
  ]);

  // Ground for the debris: board and frame, the two steps of the dais, the hall floor.
  const terraces: [number, number][] = [
    [BOARD_HALF + 0.55, 0],
    [BOARD_HALF + 1.3, -TILE_HEIGHT],
    [BOARD_HALF + 2.15, -TILE_HEIGHT - 0.22],
    [60, FLOOR_Y],
  ];
  for (const [half, top] of terraces) physics.addSlab(half, half, top);
  const ground = (x: number, z: number): number => {
    const r = Math.max(Math.abs(x), Math.abs(z));
    for (const [half, top] of terraces) if (r <= half) return top;
    return FLOOR_Y;
  };

  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = hdr;
  scene.environmentIntensity = 0.2;
  scene.add(hall.group);
  const tiles = createTiles(8, boardMaterials);
  scene.add(tiles);
  const lights = createLightRig(scene, { radius: 6.4, braziers: hall.brazierPositions, cookie: createTraceryCookie() });

  loading.progress(steps / (steps + 1), 'Teaching them to move');
  const cast = await Cast.create(kit, chess, [...ALL_CLIPS, ...ATTACK_CLIPS, ...SPECIAL_CLIPS]);
  scene.add(cast.group);

  const markers = new Markers();
  scene.add(markers.group);
  reflection = new BoardReflection(scene, camera, [tiles, markers.group], 0.85);
  fit();

  const dom = pipeline.renderer.domElement;
  const rig = new CameraRig(camera, dom);
  const picker = new Picker(camera, dom);
  const game = new ChessGame();

  const audio = new GameAudio(camera, hall.brazierPositions);
  const cinematic = localStorage.getItem('stonewake.cinema') !== '0';
  let controller!: GameController;
  let director!: Director;
  let cinema!: Cinema;
  const setCinematic = (on: boolean): void => {
    cinema.enabled = on;
    director.slowMotionEnabled = on;
    localStorage.setItem('stonewake.cinema', on ? '1' : '0');
  };
  const hud = new Hud(
    document.body,
    {
      onUndo: () => void controller.undo(),
      onNewGame: () => controller.start(),
      onFlip: () => rig.viewFor(rig.nearestSide() === 'w' ? 'b' : 'w'),
      onToggleFollow: (on) => controller.setFollow(on),
      onToggleSound: (on) => audio.setEnabled(on),
      onToggleCinema: setCinematic,
    },
    { follow: localStorage.getItem('stonewake.follow') !== '0', sound: audio.on, cinema: cinematic },
  );

  // Gaits are measured from the clips once and cached.
  const gaits = new Map<string, Gait>();
  const fx = new Effects(rig, {
    light: { position: lights.key.position, target: lights.key.target.position, color: lights.key.color, intensity: lights.key.intensity, angle: lights.key.angle, penumbra: lights.key.penumbra },
    fog: scene.fog as THREE.FogExp2,
    ground,
    looks: cast.looks,
    depth: pipeline.overlayUniforms,
    audio,
  });
  scene.add(fx.group);
  pipeline.overlay.add(fx.overlay);
  const shatter = new ShatterSystem(physics, cast, scene, fx);
  cinema = new Cinema(rig, pipeline, hud);
  cinema.scenery = hall.brazierPositions.map((b) => ({ x: b.x, z: b.z, radius: 0.7, height: 3 }));
  const viewer = { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: 30 };
  director = new Director({
    cast,
    fx,
    shatter,
    cinema,
    gait(kind: BodyKind, clip: string): Gait {
      const key = `${kind}:${clip}`;
      let g = gaits.get(key);
      if (!g) {
        g = analyzeGait(cast.clip(kind, clip), kit.rig(kind));
        gaits.set(key, g);
      }
      return g;
    },
    viewerPosition: () => rig.orbitPose(viewer).position,
  });
  setCinematic(cinematic);
  controller = new GameController({ game, cast, markers, hud, picker, rig, dom, presenter: director, sound: audio });
  controller.start();
  rig.viewFor('w', true);

  const stress = { repeat: 1 };
  const gpuTimer = new GpuTimer(pipeline.renderer.getContext() as WebGL2RenderingContext);
  const perf = new PerfRecorder();
  const frame = (dt: number, now: number): void => {
    const t0 = performance.now();
    kit.shared.uTime.value = now;
    lights.update(now);
    hall.coals.forEach((c, i) => {
      (c.material as THREE.MeshStandardMaterial).emissiveIntensity = 5 * ((lights.braziers[i].userData.flicker as number | undefined) ?? 1);
    });
    const gameDt = director.update(dt);
    for (const a of cast.actors) if (a.alive) a.updateLife(dt);
    if (shatter.active) physics.update(gameDt);
    shatter.update(gameDt);
    fx.update(gameDt);
    markers.update(dt);
    cinema.update(dt);
    rig.update(dt, gameDt);
    // Motes blur by their distance from whatever the lens is focused on.
    fx.motes.update(now, camera.position.distanceTo(pipeline.focus), pipeline.bokeh, pipeline.focusRange, pipeline.overlayUniforms.uResolution.value.y / (2 * Math.tan((camera.fov * Math.PI) / 360)));
    pipeline.overlayPass.enabled = fx.overlayActive;
    // With no renders asked for (a measurement stepping the game by hand), nothing is drawn at all.
    if (stress.repeat > 0) reflection?.render(pipeline.renderer);
    gpuTimer.begin();
    // Rendering the frame several times finds the real ceiling: at one render per refresh the
    // GPU clocks down, which makes timer queries look far worse than the actual headroom.
    for (let i = 0; i < stress.repeat; i++) pipeline.render(dt);
    gpuTimer.end();
    if (perf.recording) perf.push({ interval: dt * 1000, cpu: performance.now() - t0, gpu: gpuTimer.lastMs });
  };
  const loop = new FrameLoop(frame);
  redraw = () => {
    if (!loop.isRunning) frame(0, performance.now() / 1000);
  };

  // Compile everything, then exercise the paths a capture takes, before the reveal.
  await pipeline.renderer.compileAsync(scene, camera);
  rig.update(0);
  const warmStart = performance.now();
  warmUp({ pipeline, cast, fx, markers, stage: director.stage, physics });
  const boot = { warmUpMs: Math.round(performance.now() - warmStart) };
  loop.start();
  loading.progress(1, 'Ready');
  loading.done();

  // The title: the hall turns slowly behind it until the player clicks to begin. (Add
  // ?dev to the address to go straight to the board, as the test scripts do.)
  if (new URLSearchParams(location.search).has('dev')) {
    addEventListener('pointerdown', () => audio.unlock(), { once: true });
  } else {
    const seat = { azimuth: rig.azimuth, elevation: rig.elevation, distance: rig.distance };
    rig.setOrbit(0.9, THREE.MathUtils.degToRad(21), 15.5, true);
    rig.drift = 0.045;
    rig.inputEnabled = false;
    void hud.showTitle().then(() => {
      audio.unlock();
      rig.drift = 0;
      rig.inputEnabled = true;
      // Round to the player's seat the short way from wherever the drift had reached.
      rig.setOrbit(rig.azimuth, seat.elevation, seat.distance, false);
      rig.viewFor('w');
    });
  }

  installDebugApi({ scene, camera, pipeline, lights, cast, kit, loop, rig, game, controller, markers, perf, stress, director, frame, shatter, cinema, reflection, boot });
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;left:12px;top:12px;z-index:99;color:#f88;font:13px monospace;white-space:pre-wrap">${String(err?.stack ?? err)}</pre>`);
});
