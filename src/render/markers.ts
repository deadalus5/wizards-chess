import * as THREE from 'three';
import { SQUARE, squareCentre } from '../game/squares';

export type MarkerKind = 'move' | 'capture' | 'select' | 'last' | 'check' | 'hover';

const KIND_ID: Record<MarkerKind, number> = { move: 0, capture: 1, select: 2, last: 3, check: 4, hover: 5 };

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

// Shapes are drawn as signed-distance fields so they stay crisp at any zoom.
const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uKind;
uniform float uAlpha;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length( p );
  vec2 q = abs( p );
  float box = max( q.x, q.y );
  float a = 0.0;
  if ( uKind < 0.5 ) {
    // legal move: a soft glowing dot
    a = smoothstep( 0.2, 0.15, r ) + 0.3 * smoothstep( 0.42, 0.12, r );
  } else if ( uKind < 1.5 ) {
    // capture: a ring broken into four arcs
    float ring = smoothstep( 0.075, 0.03, abs( r - 0.74 ) );
    float gap = smoothstep( 0.1, 0.2, min( q.x, q.y ) );
    a = ring * gap + 0.12 * smoothstep( 0.9, 0.3, r );
  } else if ( uKind < 2.5 ) {
    // selection: a bright frame with a faint fill
    a = smoothstep( 0.07, 0.02, abs( box - 0.9 ) ) + 0.1 * smoothstep( 1.0, 0.3, box );
  } else if ( uKind < 3.5 ) {
    // last move: a quiet fill
    a = 0.16 * smoothstep( 1.0, 0.86, box );
  } else if ( uKind < 4.5 ) {
    // check: a pulsing glow
    a = ( 0.45 + 0.3 * sin( uTime * 5.0 ) ) * smoothstep( 1.05, 0.15, r );
  } else {
    // hover: a thin frame
    a = 0.55 * smoothstep( 0.05, 0.015, abs( box - 0.92 ) );
  }
  a *= uAlpha;
  gl_FragColor = vec4( uColor * a, a );
}`;

interface Marker {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  kind: MarkerKind;
  square: string;
  alpha: number;
  goal: number;
}

/** Glowing glyphs on the board: selection, legal moves, captures, last move, check, hover. */
export class Markers {
  readonly group = new THREE.Group();
  private readonly geometry = new THREE.PlaneGeometry(SQUARE, SQUARE);
  private readonly pool: Marker[] = [];
  private readonly active: Marker[] = [];
  private time = 0;

  constructor() {
    this.geometry.rotateX(-Math.PI / 2);
    this.group.name = 'markers';
  }

  private obtain(): Marker {
    const reused = this.pool.pop();
    if (reused) return reused;
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uColor: { value: new THREE.Color() }, uKind: { value: 0 }, uAlpha: { value: 0 }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return { mesh, material, kind: 'move', square: 'a1', alpha: 0, goal: 0 };
  }

  /** Show a marker on a square; it fades in. */
  add(kind: MarkerKind, square: string, color: THREE.ColorRepresentation, intensity = 1): void {
    const m = this.obtain();
    m.kind = kind;
    m.square = square;
    m.alpha = 0;
    m.goal = 1;
    squareCentre(square, m.mesh.position);
    // Stack kinds slightly so overlapping markers never z-fight.
    m.mesh.position.y = 0.004 + KIND_ID[kind] * 0.0015;
    m.mesh.visible = true;
    m.material.uniforms.uKind.value = KIND_ID[kind];
    (m.material.uniforms.uColor.value as THREE.Color).set(color).multiplyScalar(intensity);
    this.active.push(m);
  }

  /** Fade out and remove every marker of the given kinds (all kinds if omitted). */
  clear(...kinds: MarkerKind[]): void {
    for (const m of this.active) if (!kinds.length || kinds.includes(m.kind)) m.goal = 0;
  }

  has(kind: MarkerKind, square: string): boolean {
    return this.active.some((m) => m.kind === kind && m.square === square && m.goal > 0);
  }

  update(dt: number): void {
    this.time += dt;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const m = this.active[i];
      m.alpha += (m.goal - m.alpha) * Math.min(1, dt * 14);
      m.material.uniforms.uAlpha.value = m.alpha;
      m.material.uniforms.uTime.value = this.time;
      if (m.goal === 0 && m.alpha < 0.01) {
        m.mesh.visible = false;
        this.active.splice(i, 1);
        this.pool.push(m);
      }
    }
  }
}
