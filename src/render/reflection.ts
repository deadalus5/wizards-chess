import * as THREE from 'three';

/** Shared with the tile materials, which sample the mirror image. */
export const reflectionUniforms = {
  tReflection: { value: null as THREE.Texture | null },
  /** World position to projective coordinates in the mirror image. */
  uReflectionMatrix: { value: new THREE.Matrix4() },
  /** 0 = off. */
  uReflection: { value: 0 },
};

/**
 * The polished board mirrors what stands on it. Each frame the scene is rendered once more
 * from a camera reflected through the board's surface, into a half-size buffer with a mip
 * chain; the tile materials look that image up (blurrier where the stone is rougher) and add
 * it by the Fresnel term, so reflections are faint seen from above and strong at a glancing
 * angle, as on real polished stone.
 *
 * The method (virtual camera, oblique near plane so nothing below the board is drawn, texture
 * matrix) is the standard planar-reflection construction used by three.js's Reflector.
 */
export class BoardReflection {
  enabled = true;
  readonly target: THREE.WebGLRenderTarget;
  private readonly virtual = new THREE.PerspectiveCamera();
  private readonly plane = new THREE.Plane();
  private readonly clip = new THREE.Vector4();
  private readonly q = new THREE.Vector4();
  private readonly rotation = new THREE.Matrix4();
  private readonly eye = new THREE.Vector3();
  private readonly view = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly normal = new THREE.Vector3(0, 1, 0);
  private readonly origin = new THREE.Vector3(0, 0, 0);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    /** Things that must not appear in the mirror: the board itself and what is painted on it. */
    private readonly hidden: THREE.Object3D[],
    strength = 1,
  ) {
    this.target = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: true, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    this.target.texture.name = 'board-reflection';
    reflectionUniforms.tReflection.value = this.target.texture;
    reflectionUniforms.uReflection.value = strength;
  }

  set strength(v: number) {
    reflectionUniforms.uReflection.value = v;
  }

  get strength(): number {
    return reflectionUniforms.uReflection.value;
  }

  /** Size of the main picture in pixels; the mirror image is half that each way. */
  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(2, Math.round(width / 2)), Math.max(2, Math.round(height / 2)));
  }

  /** Render the mirror image. Call once per frame, before the main render. */
  render(renderer: THREE.WebGLRenderer): void {
    if (!this.enabled || reflectionUniforms.uReflection.value <= 0) return;
    const { camera, virtual, normal, origin } = this;
    camera.updateMatrixWorld();
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    // Below the board there is nothing to mirror.
    if (this.eye.y <= 0.01) return;

    // The camera's position and aim, reflected through the board.
    this.view.subVectors(origin, this.eye).reflect(normal).negate().add(origin);
    this.rotation.extractRotation(camera.matrixWorld);
    this.look.set(0, 0, -1).applyMatrix4(this.rotation).add(this.eye);
    this.aim.subVectors(origin, this.look).reflect(normal).negate().add(origin);
    virtual.position.copy(this.view);
    virtual.up.set(0, 1, 0).applyMatrix4(this.rotation).reflect(normal);
    virtual.lookAt(this.aim);
    virtual.far = camera.far;
    virtual.updateMatrixWorld();
    virtual.projectionMatrix.copy(camera.projectionMatrix);

    const m = reflectionUniforms.uReflectionMatrix.value;
    m.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    m.multiply(virtual.projectionMatrix);
    m.multiply(virtual.matrixWorldInverse);

    // Make the near plane the board's surface (an oblique frustum), so nothing under the
    // board gets between the mirrored camera and the scene. http://www.terathon.com/code/oblique.html
    this.plane.setFromNormalAndCoplanarPoint(normal, origin).applyMatrix4(virtual.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const p = virtual.projectionMatrix.elements;
    this.q.x = (Math.sign(this.clip.x) + p[8]) / p[0];
    this.q.y = (Math.sign(this.clip.y) + p[9]) / p[5];
    this.q.z = -1;
    this.q.w = (1 + p[10]) / p[14];
    this.clip.multiplyScalar(2 / this.clip.dot(this.q));
    p[2] = this.clip.x;
    p[6] = this.clip.y;
    p[10] = this.clip.z + 1 - 0.003;
    p[14] = this.clip.w;

    const visible = this.hidden.map((o) => o.visible);
    for (const o of this.hidden) o.visible = false;
    const autoUpdate = renderer.shadowMap.autoUpdate;
    // The shadow map from the last frame will do; rendering it twice a frame would not.
    renderer.shadowMap.autoUpdate = false;
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, virtual);
    renderer.setRenderTarget(previous);
    renderer.shadowMap.autoUpdate = autoUpdate;
    this.hidden.forEach((o, i) => (o.visible = visible[i]));
  }
}
