import * as THREE from 'three';

/**
 * Per-chunk rigid matrices for one shattering statue, as a float texture the vertex shader
 * reads: one row of four texels (the columns of a mat4) per chunk.
 */
export class ChunkField {
  readonly data: Float32Array;
  readonly texture: THREE.DataTexture;
  readonly uniform: THREE.IUniform<THREE.Texture | null>;

  constructor(readonly rows: number) {
    this.data = new Float32Array(rows * 16);
    this.texture = new THREE.DataTexture(this.data, 4, rows, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.name = 'chunk-matrices';
    this.uniform = { value: this.texture };
    this.setIdentity();
  }

  setIdentity(): void {
    this.data.fill(0);
    for (let r = 0; r < this.rows; r++) {
      this.data[r * 16] = 1;
      this.data[r * 16 + 5] = 1;
      this.data[r * 16 + 10] = 1;
      this.data[r * 16 + 15] = 1;
    }
    this.texture.needsUpdate = true;
  }

  setMatrix(row: number, m: THREE.Matrix4): void {
    this.data.set(m.elements, row * 16);
  }

  commit(): void {
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
