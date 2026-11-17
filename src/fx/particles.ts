import * as THREE from 'three';
import { Rng } from '../core/math';
import type { OverlayUniforms } from '../render/pipeline';

/** Height of the ground under a point: the board, the steps of the dais, the hall floor. */
export type GroundFn = (x: number, z: number) => number;

/** The key light, so dust can be lit the way the stone it came from is lit. */
export interface DustLight {
  position: THREE.Vector3;
  target: THREE.Vector3;
  color: THREE.Color;
  intensity: number;
  /** Half-angle of the cone, radians. */
  angle: number;
  penumbra: number;
}

/** A tileable soft noise texture that breaks dust puffs up into wisps. */
function createWispTexture(size = 128): THREE.DataTexture {
  const rng = new Rng(77);
  const octave = (cells: number): Float32Array => {
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells;
        const fy = (y / size) * cells;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const g = (ix: number, iy: number): number => grid[(iy % cells) * cells + (ix % cells)];
        const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * sx;
        const b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * sx;
        out[y * size + x] = a + (b - a) * sy;
      }
    }
    return out;
  };
  const layers = [octave(4), octave(8), octave(16), octave(32)];
  const weights = [0.5, 0.27, 0.15, 0.08];
  const data = new Uint8Array(size * size);
  for (let i = 0; i < data.length; i++) {
    let v = 0;
    for (let l = 0; l < layers.length; l++) v += layers[l][i] * weights[l];
    data[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.name = 'wisp-noise';
  return tex;
}

function quad(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

function instanced(g: THREE.InstancedBufferGeometry, name: string, array: Float32Array, itemSize: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(array, itemSize);
  a.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute(name, a);
  return a;
}

export interface PuffOptions {
  /** Radius at birth and at the end of its life, metres. */
  size: number;
  grow: number;
  life: number;
  /** Peak opacity. */
  alpha: number;
  color: THREE.Color;
  /** How quickly it loses speed (per second). */
  drag?: number;
  /** Upward drift, metres per second squared (negative sinks). */
  rise?: number;
}

/**
 * Dust: soft billboards lit by the key light, eroded by noise into wisps, fading where they
 * would cut into the floor. Simulated on the CPU (a few hundred puffs at most).
 */
export class Dust {
  static readonly MAX = 1200;
  readonly mesh: THREE.Mesh;
  private count = 0;
  private readonly pos = new Float32Array(Dust.MAX * 3);
  private readonly vel = new Float32Array(Dust.MAX * 3);
  private readonly col = new Float32Array(Dust.MAX * 3);
  // age, life, size, grow, alpha, drag, rise, rotation, spin, seed
  private readonly state = new Float32Array(Dust.MAX * 10);
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aMisc: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly rng = new Rng(4242);

  constructor(
    light: DustLight,
    fog: THREE.FogExp2 | null,
    private readonly ground: GroundFn,
    depth: OverlayUniforms,
  ) {
    const g = quad();
    this.geometry = g;
    this.aPos = instanced(g, 'iPos', new Float32Array(Dust.MAX * 3), 3);
    this.aMisc = instanced(g, 'iMisc', new Float32Array(Dust.MAX * 4), 4);
    this.aColor = instanced(g, 'iColor', new Float32Array(Dust.MAX * 3), 3);
    g.instanceCount = 0;

    const axis = new THREE.Vector3().subVectors(light.target, light.position).normalize();
    const material = new THREE.ShaderMaterial({
      name: 'dust',
      transparent: true,
      depthTest: false,
      depthWrite: false,
      premultipliedAlpha: true,
      uniforms: {
        ...depth,
        tWisp: { value: createWispTexture() },
        uLightPos: { value: light.position.clone() },
        uLightAxis: { value: axis },
        uLightColor: { value: light.color.clone().multiplyScalar(light.intensity) },
        uCone: { value: new THREE.Vector2(Math.cos(light.angle), Math.cos(light.angle * (1 - light.penumbra))) },
        uAmbient: { value: new THREE.Color(0.05, 0.045, 0.045) },
        uFogDensity: { value: fog?.density ?? 0 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 iPos;
        attribute vec4 iMisc; // size, rotation, alpha, seed
        attribute vec3 iColor;
        uniform vec3 uLightPos;
        uniform vec3 uLightAxis;
        uniform vec3 uLightColor;
        uniform vec2 uCone;
        uniform vec3 uAmbient;
        uniform float uFogDensity;
        varying vec2 vUv;
        varying vec2 vSeed;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vViewZ;
        varying float vUp;
        void main() {
          float c = cos( iMisc.y );
          float s = sin( iMisc.y );
          // Each puff is stretched by a different amount, so no two read as the same disc.
          vec2 stretched = position.xy * vec2( 1.0 + 0.7 * fract( iMisc.w * 13.7 ), 1.0 - 0.3 * fract( iMisc.w * 5.3 ) );
          vec2 corner = vec2( c * stretched.x - s * stretched.y, s * stretched.x + c * stretched.y ) * iMisc.x * 2.0;
          vec4 mv = viewMatrix * vec4( iPos, 1.0 );
          mv.xy += corner;
          gl_Position = projectionMatrix * mv;
          vUv = uv;
          vSeed = vec2( iMisc.w, fract( iMisc.w * 7.31 ) );
          vViewZ = mv.z;
          // Which way is up across the billboard, for shading the top brighter than the base.
          vec3 camUp = vec3( viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1] );
          vec3 camRight = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] );
          vUp = c * camUp.y - s * camRight.y;

          // Lit like the stone: the key light's cone and distance falloff, plus a little ambient.
          vec3 toP = iPos - uLightPos;
          float dist = length( toP );
          float cone = smoothstep( uCone.x, uCone.y, dot( toP / dist, uLightAxis ) );
          vec3 light = uAmbient + uLightColor * cone / ( dist * dist ) * 0.2;
          vColor = iColor * light;
          float fogDepth = - mv.z;
          vAlpha = iMisc.z * exp( - uFogDensity * uFogDensity * fogDepth * fogDepth );
        }`,
      fragmentShader: /* glsl */ `
        #include <packing>
        uniform sampler2D tWisp;
        uniform sampler2D tDepth;
        uniform vec2 uResolution;
        uniform vec2 uNearFar;
        varying vec2 vUv;
        varying vec2 vSeed;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vViewZ;
        varying float vUp;
        void main() {
          // How far this bit of dust is in front of whatever the scene has there.
          float sceneZ = perspectiveDepthToViewZ( texture2D( tDepth, gl_FragCoord.xy / uResolution ).r, uNearFar.x, uNearFar.y );
          float gap = vViewZ - sceneZ;
          if ( gap <= 0.0 ) discard;
          vec2 p = vUv - 0.5;
          float d = length( p ) * 2.0;
          float body = 1.0 - smoothstep( 0.0, 1.0, d );
          float n = texture2D( tWisp, vUv * 0.5 + vSeed ).r * 0.55 + texture2D( tWisp, vUv * 1.4 + vSeed.yx ).r * 0.45;
          // Erode with noise so the puff is ragged wisps, not a disc.
          float a = smoothstep( 0.3, 0.8, body + ( n - 0.5 ) * 2.6 ) * body;
          // Fade where it meets a surface, so a puff never shows a hard line against the floor.
          a *= vAlpha * smoothstep( 0.0, 0.3, gap );
          if ( a < 0.002 ) discard;
          // Thicker parts are a little darker (self-shadowing); the side towards the sky is lighter.
          float shade = ( 0.82 + 0.3 * ( 1.0 - n ) ) * ( 1.0 + 0.5 * p.y * vUp );
          gl_FragColor = vec4( vColor * shade * a, a );
        }`,
    });
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.name = 'dust';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  get alive(): number {
    return this.count;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, o: PuffOptions): void {
    if (this.count >= Dust.MAX) return;
    const i = this.count++;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([o.color.r, o.color.g, o.color.b], i * 3);
    const rng = this.rng;
    this.state.set([0, o.life, o.size, o.grow, o.alpha, o.drag ?? 2.2, o.rise ?? 0.12, rng.range(0, Math.PI * 2), rng.range(-0.5, 0.5), rng.next()], i * 10);
  }

  update(dt: number): void {
    const { pos, vel, col, state } = this;
    const aPos = this.aPos.array as Float32Array;
    const aMisc = this.aMisc.array as Float32Array;
    const aColor = this.aColor.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      const s = i * 10;
      const p = i * 3;
      state[s] += dt;
      if (state[s] >= state[s + 1]) {
        // Dead: move the last live puff into this slot.
        const last = --this.count;
        if (last !== i) {
          pos.copyWithin(p, last * 3, last * 3 + 3);
          vel.copyWithin(p, last * 3, last * 3 + 3);
          col.copyWithin(p, last * 3, last * 3 + 3);
          state.copyWithin(s, last * 10, last * 10 + 10);
        }
        i--;
        continue;
      }
      const damp = Math.exp(-state[s + 5] * dt);
      vel[p] *= damp;
      vel[p + 1] = vel[p + 1] * damp + state[s + 6] * dt;
      vel[p + 2] *= damp;
      pos[p] += vel[p] * dt;
      pos[p + 1] += vel[p + 1] * dt;
      pos[p + 2] += vel[p + 2] * dt;
      state[s + 7] += state[s + 8] * dt;
      // Dust that reaches the floor spreads along it instead of sinking through.
      if (vel[p + 1] < 0) {
        const floor = this.ground(pos[p], pos[p + 2]) + 0.05;
        if (pos[p + 1] < floor) {
          pos[p + 1] = floor;
          vel[p + 1] = 0;
        }
      }

      const u = state[s] / state[s + 1];
      const grown = (1 - Math.exp(-4 * u)) / (1 - Math.exp(-4));
      const fadeIn = Math.min(1, u / 0.06);
      const k = Math.min(1, Math.max(0, (u - 0.25) / 0.75));
      const fadeOut = 1 - k * k * (3 - 2 * k);
      aPos[p] = pos[p];
      aPos[p + 1] = pos[p + 1];
      aPos[p + 2] = pos[p + 2];
      const m = i * 4;
      aMisc[m] = state[s + 2] + (state[s + 3] - state[s + 2]) * grown;
      aMisc[m + 1] = state[s + 7];
      aMisc[m + 2] = state[s + 4] * fadeIn * fadeOut;
      aMisc[m + 3] = state[s + 9];
      aColor[p] = col[p];
      aColor[p + 1] = col[p + 1];
      aColor[p + 2] = col[p + 2];
    }
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      this.aPos.needsUpdate = true;
      this.aMisc.needsUpdate = true;
      this.aColor.needsUpdate = true;
    }
  }

  clear(): void {
    this.count = 0;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }
}

/**
 * Sparks and flashes: additive streaks drawn along their own motion, bright enough to bloom.
 * A spark with no velocity is a round glow, which is how impact flashes are drawn.
 */
export class Sparks {
  static readonly MAX = 600;
  readonly mesh: THREE.Mesh;
  private count = 0;
  private readonly pos = new Float32Array(Sparks.MAX * 3);
  private readonly vel = new Float32Array(Sparks.MAX * 3);
  private readonly col = new Float32Array(Sparks.MAX * 3);
  // age, life, size, gravity, drag, grow
  private readonly state = new Float32Array(Sparks.MAX * 6);
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aVel: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private readonly geometry: THREE.InstancedBufferGeometry;

  constructor(
    private readonly ground: GroundFn,
    depth: OverlayUniforms,
  ) {
    const g = quad();
    this.geometry = g;
    this.aPos = instanced(g, 'iPos', new Float32Array(Sparks.MAX * 3), 3);
    this.aVel = instanced(g, 'iVel', new Float32Array(Sparks.MAX * 4), 4);
    this.aColor = instanced(g, 'iColor', new Float32Array(Sparks.MAX * 3), 3);
    g.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      name: 'sparks',
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // Added to the colour; the layer's coverage (alpha) is left alone.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      uniforms: { ...depth },
      vertexShader: /* glsl */ `
        attribute vec3 iPos;
        attribute vec4 iVel; // velocity, size
        attribute vec3 iColor;
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vViewZ;
        void main() {
          vec4 mv = viewMatrix * vec4( iPos, 1.0 );
          vViewZ = mv.z;
          vec3 vv = ( viewMatrix * vec4( iVel.xyz, 0.0 ) ).xyz;
          float speed = length( vv.xy );
          vec2 dir = speed > 1e-4 ? vv.xy / speed : vec2( 1.0, 0.0 );
          // Streak length follows speed (as a shutter would smear it).
          float len = iVel.w * ( 1.0 + speed * 0.02 / max( iVel.w, 1e-4 ) );
          mv.xy += dir * position.x * len * 2.0 + vec2( - dir.y, dir.x ) * position.y * iVel.w * 2.0;
          gl_Position = projectionMatrix * mv;
          vUv = uv;
          vColor = iColor;
        }`,
      fragmentShader: /* glsl */ `
        #include <packing>
        uniform sampler2D tDepth;
        uniform vec2 uResolution;
        uniform vec2 uNearFar;
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vViewZ;
        void main() {
          float sceneZ = perspectiveDepthToViewZ( texture2D( tDepth, gl_FragCoord.xy / uResolution ).r, uNearFar.x, uNearFar.y );
          float gap = vViewZ - sceneZ;
          if ( gap <= 0.0 ) discard;
          vec2 p = ( vUv - 0.5 ) * 2.0;
          float a = exp( - dot( p, p ) * 4.0 ) - 0.018;
          if ( a <= 0.0 ) discard;
          gl_FragColor = vec4( vColor * a * smoothstep( 0.0, 0.05, gap ), 0.0 );
        }`,
    });
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.name = 'sparks';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
  }

  get alive(): number {
    return this.count;
  }

  /** `gravity` 1 = falls like a stone, 0 = floats. `grow` scales the size over its life (for flashes). */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, color: THREE.Color, intensity: number, gravity = 1, drag = 1.2, grow = 1): void {
    if (this.count >= Sparks.MAX) return;
    const i = this.count++;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([color.r * intensity, color.g * intensity, color.b * intensity], i * 3);
    this.state.set([0, life, size, gravity, drag, grow], i * 6);
  }

  update(dt: number): void {
    const { pos, vel, col, state } = this;
    const aPos = this.aPos.array as Float32Array;
    const aVel = this.aVel.array as Float32Array;
    const aColor = this.aColor.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      const s = i * 6;
      const p = i * 3;
      state[s] += dt;
      if (state[s] >= state[s + 1]) {
        const last = --this.count;
        if (last !== i) {
          pos.copyWithin(p, last * 3, last * 3 + 3);
          vel.copyWithin(p, last * 3, last * 3 + 3);
          col.copyWithin(p, last * 3, last * 3 + 3);
          state.copyWithin(s, last * 6, last * 6 + 6);
        }
        i--;
        continue;
      }
      const damp = Math.exp(-state[s + 4] * dt);
      vel[p] *= damp;
      vel[p + 1] = vel[p + 1] * damp - 9.81 * state[s + 3] * dt;
      vel[p + 2] *= damp;
      pos[p] += vel[p] * dt;
      pos[p + 1] += vel[p + 1] * dt;
      pos[p + 2] += vel[p + 2] * dt;
      // Sparks skitter off the floor.
      if (state[s + 3] > 0) {
        const floor = this.ground(pos[p], pos[p + 2]) + 0.01;
        if (pos[p + 1] < floor && vel[p + 1] < 0) {
          pos[p + 1] = floor;
          vel[p + 1] *= -0.42;
          vel[p] *= 0.7;
          vel[p + 2] *= 0.7;
        }
      }
      const u = state[s] / state[s + 1];
      const fade = (1 - u) * (1 - u);
      aPos[p] = pos[p];
      aPos[p + 1] = pos[p + 1];
      aPos[p + 2] = pos[p + 2];
      const v = i * 4;
      aVel[v] = vel[p];
      aVel[v + 1] = vel[p + 1];
      aVel[v + 2] = vel[p + 2];
      aVel[v + 3] = state[s + 2] * (1 + (state[s + 5] - 1) * u);
      aColor[p] = col[p] * fade;
      aColor[p + 1] = col[p + 1] * fade;
      aColor[p + 2] = col[p + 2] * fade;
    }
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      this.aPos.needsUpdate = true;
      this.aVel.needsUpdate = true;
      this.aColor.needsUpdate = true;
    }
  }

  clear(): void {
    this.count = 0;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }
}

/**
 * Shards: the small chips that fly from a blow, too small and too many to be worth rigid
 * bodies. Each is a faceted pebble thrown ballistically, bouncing and coming to rest on the
 * floor, then shrinking away.
 */
export class Shards {
  static readonly MAX = 480;
  readonly mesh: THREE.InstancedMesh;
  private count = 0;
  private readonly pos = new Float32Array(Shards.MAX * 3);
  private readonly vel = new Float32Array(Shards.MAX * 3);
  private readonly quat = new Float32Array(Shards.MAX * 4);
  private readonly spin = new Float32Array(Shards.MAX * 3);
  private readonly scale = new Float32Array(Shards.MAX * 3);
  private readonly col = new Float32Array(Shards.MAX * 3);
  // age, life, resting (0/1)
  private readonly state = new Float32Array(Shards.MAX * 3);
  private readonly rng = new Rng(991);

  constructor(private readonly ground: GroundFn) {
    // A pebble: a dodecahedron with its corners pushed about.
    const g = new THREE.DodecahedronGeometry(1, 0);
    const p = g.getAttribute('position');
    const rng = new Rng(13);
    const moved = new Map<string, [number, number, number]>();
    for (let i = 0; i < p.count; i++) {
      const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
      let m = moved.get(key);
      if (!m) {
        const k = rng.range(0.55, 1.2);
        m = [p.getX(i) * k, p.getY(i) * k * 0.7, p.getZ(i) * k];
        moved.set(key, m);
      }
      p.setXYZ(i, m[0], m[1], m[2]);
    }
    g.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0, flatShading: true });
    material.name = 'shards';
    this.mesh = new THREE.InstancedMesh(g, material, Shards.MAX);
    this.mesh.name = 'shards';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
  }

  get alive(): number {
    return this.count;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, color: THREE.Color): void {
    if (this.count >= Shards.MAX) return;
    const i = this.count++;
    const rng = this.rng;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    _q.setFromEuler(_e.set(rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28)));
    this.quat.set([_q.x, _q.y, _q.z, _q.w], i * 4);
    this.spin.set([rng.range(-14, 14), rng.range(-14, 14), rng.range(-14, 14)], i * 3);
    this.scale.set([size * rng.range(0.7, 1.4), size * rng.range(0.5, 1), size * rng.range(0.7, 1.3)], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.state.set([0, life, 0], i * 3);
  }

  update(dt: number): void {
    const { pos, vel, quat, spin, scale, col, state } = this;
    const colors = this.mesh.instanceColor!.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      const p = i * 3;
      state[p] += dt;
      if (state[p] >= state[p + 1]) {
        const last = --this.count;
        if (last !== i) {
          pos.copyWithin(p, last * 3, last * 3 + 3);
          vel.copyWithin(p, last * 3, last * 3 + 3);
          quat.copyWithin(i * 4, last * 4, last * 4 + 4);
          spin.copyWithin(p, last * 3, last * 3 + 3);
          scale.copyWithin(p, last * 3, last * 3 + 3);
          col.copyWithin(p, last * 3, last * 3 + 3);
          state.copyWithin(p, last * 3, last * 3 + 3);
        }
        i--;
        continue;
      }
      if (state[p + 2] < 0.5) {
        vel[p + 1] -= 9.81 * dt;
        pos[p] += vel[p] * dt;
        pos[p + 1] += vel[p + 1] * dt;
        pos[p + 2] += vel[p + 2] * dt;
        const floor = this.ground(pos[p], pos[p + 2]) + scale[p + 1] * 0.6;
        if (pos[p + 1] < floor) {
          pos[p + 1] = floor;
          if (vel[p + 1] < -0.9) {
            vel[p + 1] *= -0.32;
            vel[p] *= 0.62;
            vel[p + 2] *= 0.62;
            spin[p] *= 0.6;
            spin[p + 1] *= 0.6;
            spin[p + 2] *= 0.6;
          } else {
            // Slow enough to stay down: slide to a stop.
            vel[p + 1] = 0;
            const slide = Math.exp(-7 * dt);
            vel[p] *= slide;
            vel[p + 2] *= slide;
            spin[p] *= slide;
            spin[p + 1] *= slide;
            spin[p + 2] *= slide;
            if (vel[p] * vel[p] + vel[p + 2] * vel[p + 2] < 0.0004) state[p + 2] = 1;
          }
        }
        // Tumble.
        const w = Math.hypot(spin[p], spin[p + 1], spin[p + 2]);
        if (w > 1e-3) {
          _q.set(quat[i * 4], quat[i * 4 + 1], quat[i * 4 + 2], quat[i * 4 + 3]);
          _dq.setFromAxisAngle(_v.set(spin[p] / w, spin[p + 1] / w, spin[p + 2] / w), w * dt);
          _q.premultiply(_dq);
          quat.set([_q.x, _q.y, _q.z, _q.w], i * 4);
        }
      }
      // Shrink away at the end of its life.
      const left = state[p + 1] - state[p];
      const k = left < 0.4 ? left / 0.4 : 1;
      _q.set(quat[i * 4], quat[i * 4 + 1], quat[i * 4 + 2], quat[i * 4 + 3]);
      _m.compose(_v.set(pos[p], pos[p + 1] - (1 - k) * scale[p + 1] * 0.6, pos[p + 2]), _q, _s.set(scale[p] * k, scale[p + 1] * k, scale[p + 2] * k));
      _m.toArray(this.mesh.instanceMatrix.array, i * 16);
      colors[p] = col[p];
      colors[p + 1] = col[p + 1];
      colors[p + 2] = col[p + 2];
    }
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor!.needsUpdate = true;
    }
  }

  clear(): void {
    this.count = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }
}

const _q = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Motes: dust hanging in the air of the hall, catching the key light. They are animated
 * entirely in the vertex shader (a slow drift that wraps round a box over the board), and
 * because the particle layer is drawn after depth of field they blur themselves: each mote
 * grows into a soft disc by how far it is from the plane of focus, and dims to match.
 */
export class Motes {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;

  constructor(count: number, min: THREE.Vector3, max: THREE.Vector3, light: DustLight, depth: OverlayUniforms) {
    const rng = new Rng(808);
    const position = new Float32Array(count * 3);
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      position.set([rng.next(), rng.next(), rng.next()], i * 3);
      // phase, drift, size in metres, brightness
      seed.set([rng.next(), rng.next(), rng.range(0.004, 0.009), rng.range(0.35, 1)], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    const axis = new THREE.Vector3().subVectors(light.target, light.position).normalize();
    this.material = new THREE.ShaderMaterial({
      name: 'motes',
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      uniforms: {
        ...depth,
        uTime: { value: 0 },
        uBoxMin: { value: min.clone() },
        uBoxSize: { value: new THREE.Vector3().subVectors(max, min) },
        uLightPos: { value: light.position.clone() },
        uLightAxis: { value: axis },
        uLightColor: { value: light.color.clone().multiplyScalar(light.intensity) },
        uCone: { value: new THREE.Vector2(Math.cos(light.angle), Math.cos(light.angle * (1 - light.penumbra))) },
        /** x: distance to the plane of focus, y: blur strength (0 = everything sharp), z: metres over which blur reaches full. */
        uFocus: { value: new THREE.Vector3(10, 0, 4) },
        /** Pixels per metre at one metre from the camera. */
        uPixels: { value: 1000 },
        uStrength: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uTime;
        uniform vec3 uBoxMin;
        uniform vec3 uBoxSize;
        uniform vec3 uLightPos;
        uniform vec3 uLightAxis;
        uniform vec3 uLightColor;
        uniform vec2 uCone;
        uniform vec3 uFocus;
        uniform float uPixels;
        uniform vec2 uResolution;
        varying vec3 vColor;
        varying float vViewZ;
        varying float vSoft;
        void main() {
          // A slow drift, each mote on its own heading, sinking very slightly, with a wander.
          vec3 p = position + uTime * vec3( 0.006 * ( aSeed.x - 0.5 ), -0.0025 * aSeed.y, 0.006 * ( fract( aSeed.x * 7.3 ) - 0.5 ) );
          p += 0.012 * vec3( sin( uTime * 0.31 + aSeed.x * 40.0 ), sin( uTime * 0.23 + aSeed.y * 30.0 ), cos( uTime * 0.27 + aSeed.x * 50.0 ) );
          p = fract( p );
          // Fade at the faces of the box so wrapping round is never seen.
          vec3 edge = smoothstep( 0.0, 0.06, p ) * smoothstep( 0.0, 0.06, 1.0 - p );
          vec3 world = uBoxMin + p * uBoxSize;
          vec4 mv = viewMatrix * vec4( world, 1.0 );
          vViewZ = mv.z;
          float dist = max( 0.2, - mv.z );
          float size = aSeed.z * uPixels / dist;
          float blur = uFocus.y * clamp( abs( dist - uFocus.x ) / uFocus.z, 0.0, 1.0 ) * uResolution.y * 0.0026;
          float shown = clamp( size + blur, 1.0, 72.0 );
          gl_PointSize = shown;
          gl_Position = projectionMatrix * mv;
          vSoft = clamp( blur / shown, 0.0, 1.0 );

          vec3 toP = world - uLightPos;
          float d = length( toP );
          float cone = smoothstep( uCone.x, uCone.y, dot( toP / d, uLightAxis ) );
          float twinkle = 0.55 + 0.45 * sin( uTime * ( 0.7 + aSeed.y ) + aSeed.x * 60.0 );
          // The light a mote scatters is spread over the disc it is drawn as.
          float spread = min( 1.0, ( size * size ) / ( shown * shown ) );
          vColor = ( vec3( 0.012, 0.014, 0.02 ) + uLightColor * cone / ( d * d ) * 0.42 ) * aSeed.w * twinkle * spread * edge.x * edge.y * edge.z * 10.0;
        }`,
      fragmentShader: /* glsl */ `
        #include <packing>
        uniform sampler2D tDepth;
        uniform vec2 uResolution;
        uniform vec2 uNearFar;
        uniform float uStrength;
        varying vec3 vColor;
        varying float vViewZ;
        varying float vSoft;
        void main() {
          float sceneZ = perspectiveDepthToViewZ( texture2D( tDepth, gl_FragCoord.xy / uResolution ).r, uNearFar.x, uNearFar.y );
          if ( vViewZ - sceneZ <= 0.0 ) discard;
          float r = length( gl_PointCoord - 0.5 ) * 2.0;
          // In focus: a soft speck. Out of focus: a flat disc with a slightly brighter rim, as a lens draws it.
          float speck = exp( - r * r * 4.0 );
          float disc = ( 1.0 - smoothstep( 0.82, 1.0, r ) ) * ( 0.75 + 0.35 * smoothstep( 0.55, 0.9, r ) );
          float a = mix( speck, disc, vSoft );
          gl_FragColor = vec4( vColor * a * uStrength, 0.0 );
        }`,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.name = 'motes';
    this.points.frustumCulled = false;
    this.points.renderOrder = 9;
  }

  /** `strength` 0 hides them. */
  set strength(v: number) {
    this.material.uniforms.uStrength.value = v;
    this.points.visible = v > 0.001;
  }

  get visible(): boolean {
    return this.points.visible;
  }

  /**
   * @param focusDistance distance from the camera to what is in focus
   * @param blur depth-of-field strength (0 when everything is sharp)
   * @param range metres from the plane of focus at which blur is full
   * @param pixelsPerMetre size in pixels of one metre seen from one metre away
   */
  update(time: number, focusDistance: number, blur: number, range: number, pixelsPerMetre: number): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    (u.uFocus.value as THREE.Vector3).set(focusDistance, blur, range);
    u.uPixels.value = pixelsPerMetre;
  }
}
