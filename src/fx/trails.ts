import * as THREE from 'three';
import type { OverlayUniforms } from '../render/pipeline';

/** Anything that can say where a weapon's grip-to-tip line is at a clip time, in the wielder's frame. */
export interface WeaponPath {
  point(time: number, along: number, out?: THREE.Vector3): THREE.Vector3;
}

const SEGMENTS = 30;

/**
 * The glowing arc a weapon leaves behind it. The ribbon is not built from where the weapon was
 * on previous frames (which would be a polygon at film frame rates and would stretch in slow
 * motion) but from the weapon's planned path: every frame it is the surface swept over the
 * last tenth of a second of the attack clip, sampled finely.
 */
export class WeaponTrail {
  readonly mesh: THREE.Mesh;
  private readonly positions: THREE.BufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private shown = false;

  constructor(depth: OverlayUniforms) {
    const g = new THREE.BufferGeometry();
    const count = (SEGMENTS + 1) * 2;
    this.positions = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    this.positions.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.positions);
    const uv = new Float32Array(count * 2);
    const index: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      // u: 0 at the weapon, 1 at the tail of the trail. v: 0 nearer the grip, 1 at the far end.
      uv.set([i / SEGMENTS, 0, i / SEGMENTS, 1], i * 4);
      if (i < SEGMENTS) {
        const a = i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(index);
    this.material = new THREE.ShaderMaterial({
      name: 'weapon-trail',
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      uniforms: { ...depth, uColor: { value: new THREE.Color() }, uStrength: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying float vViewZ;
        void main() {
          vUv = uv;
          vec4 mv = viewMatrix * vec4( position, 1.0 );
          vViewZ = mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        #include <packing>
        uniform sampler2D tDepth;
        uniform vec2 uResolution;
        uniform vec2 uNearFar;
        uniform vec3 uColor;
        uniform float uStrength;
        varying vec2 vUv;
        varying float vViewZ;
        void main() {
          float sceneZ = perspectiveDepthToViewZ( texture2D( tDepth, gl_FragCoord.xy / uResolution ).r, uNearFar.x, uNearFar.y );
          if ( vViewZ - sceneZ <= 0.0 ) discard;
          // Brightest along the cutting edge and at the weapon, fading back along the arc.
          float along = 1.0 - vUv.x;
          // A thin bright line where the far end has passed, with a faint veil inside it.
          float edge = pow( vUv.y, 6.0 ) * ( 1.0 - smoothstep( 0.965, 1.0, vUv.y ) );
          float a = along * along * ( 0.07 * vUv.y + edge ) * smoothstep( 0.0, 0.05, vUv.x );
          gl_FragColor = vec4( uColor * uStrength * a, 0.0 );
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'weapon-trail';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.visible = false;
  }

  get visible(): boolean {
    return this.shown;
  }

  /**
   * Show the arc swept by `path` over the `length` seconds of clip time ending at `time`, for
   * a wielder standing at `origin` with heading `yaw`. Call every frame while it should show.
   */
  show(path: WeaponPath, origin: THREE.Vector3, yaw: number, time: number, length: number, from: number, color: THREE.Color, strength: number): void {
    const p = this.positions.array as Float32Array;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = Math.max(0, time - (i / SEGMENTS) * length);
      for (let e = 0; e < 2; e++) {
        path.point(t, e === 0 ? from : 1, _v);
        const k = (i * 2 + e) * 3;
        // Rotate from the wielder's frame into the world.
        p[k] = origin.x + _v.x * c + _v.z * s;
        p[k + 1] = origin.y + _v.y;
        p[k + 2] = origin.z - _v.x * s + _v.z * c;
      }
    }
    this.positions.needsUpdate = true;
    (this.material.uniforms.uColor.value as THREE.Color).copy(color);
    this.material.uniforms.uStrength.value = strength;
    this.mesh.visible = strength > 0.003;
    this.shown = this.mesh.visible;
  }

  hide(): void {
    this.mesh.visible = false;
    this.shown = false;
  }
}

const _v = new THREE.Vector3();
