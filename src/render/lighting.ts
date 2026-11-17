import * as THREE from 'three';

/**
 * The fixed light rig. Every light is created up front and stays in the scene: adding,
 * removing or toggling a light changes the lighting state hash and recompiles every lit
 * material, which would stall the frame. Only intensities and colours animate.
 */
export interface LightRig {
  /** Cool, shadow-casting key: moonlight falling on the board. */
  key: THREE.SpotLight;
  /** Edge lights that separate dark figures from the dark hall. */
  rims: THREE.DirectionalLight[];
  /** Warm, flickering brazier light (no shadows). */
  braziers: THREE.PointLight[];
  /** Very low sky/ground fill so shadowed stone never goes to pure black. */
  fill: THREE.HemisphereLight;
  update(time: number): void;
}

export interface LightRigOptions {
  /** Radius of the area the key light must cover, in metres. */
  radius: number;
  /** Where the brazier lights sit. */
  braziers: THREE.Vector3[];
  /** Optional pattern projected by the key light. */
  cookie?: THREE.Texture;
}

export function createLightRig(scene: THREE.Scene, { radius, braziers: brazierPositions, cookie }: LightRigOptions): LightRig {
  const key = new THREE.SpotLight(0xf3f1ee, 470, 0, 0.5, 0.75, 2);
  key.name = 'key';
  const keyDistance = Math.max(12, radius * 1.9);
  key.position.set(-0.62 * keyDistance, 0.76 * keyDistance, 0.2 * keyDistance);
  key.target.position.set(0, 0.6, 0);
  key.angle = Math.atan((radius * 1.25) / keyDistance);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.camera.near = Math.max(1, keyDistance - radius * 1.6);
  key.shadow.camera.far = keyDistance + radius * 1.6;
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 2.5;
  if (cookie) key.map = cookie;
  scene.add(key, key.target);

  const rimSpecs: Array<[number, [number, number, number], number]> = [
    [0x7fa4ff, [0.9, 0.45, -0.7], 1.3],
    [0x9bb6ff, [0.2, 0.4, 1], 0.5],
  ];
  const rims = rimSpecs.map(([color, dir, intensity], i) => {
    const light = new THREE.DirectionalLight(color, intensity);
    light.name = `rim-${i}`;
    light.position.set(dir[0], dir[1], dir[2]).multiplyScalar(20);
    scene.add(light);
    return light;
  });

  const braziers = brazierPositions.map((p, i) => {
    const light = new THREE.PointLight(0xff8b3d, 26, radius * 6, 2);
    light.name = `brazier-${i}`;
    light.position.copy(p);
    light.userData.base = 26;
    light.userData.phase = i * 1.7;
    scene.add(light);
    return light;
  });

  const fill = new THREE.HemisphereLight(0x2a3a5c, 0x1a120c, 0.07);
  fill.name = 'fill';
  scene.add(fill);

  return {
    key,
    rims,
    braziers,
    fill,
    update(time: number): void {
      for (const b of braziers) {
        const ph = b.userData.phase as number;
        // Layered sines read as fire without the cost or popping of random noise.
        const flicker = 1 + 0.1 * Math.sin(time * 9.1 + ph) + 0.07 * Math.sin(time * 14.7 + ph * 2.3) + 0.05 * Math.sin(time * 23.3 + ph * 0.7);
        b.intensity = (b.userData.base as number) * flicker;
        b.userData.flicker = flicker;
      }
    },
  };
}
