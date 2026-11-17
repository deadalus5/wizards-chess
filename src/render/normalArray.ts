import * as THREE from 'three';

/**
 * Packs several tangent-space normal maps into one 2D array texture so every statue, whatever
 * mix of body, hair and head-piece it is made of, can use a single material and one draw call.
 * Layer 0 is a flat normal for parts that have no map.
 *
 * Rows are stored top-first, matching glTF UVs (v = 0 at the top of the image).
 */
export async function createNormalArray(urls: readonly string[], size = 2048): Promise<THREE.DataArrayTexture> {
  const layers = urls.length + 1;
  const data = new Uint8Array(size * size * 4 * layers);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = 128;
    data[i * 4 + 1] = 128;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }

  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  await Promise.all(
    urls.map(async (url, i) => {
      const blob = await (await fetch(url)).blob();
      // No colour-space conversion or premultiplication: these are vectors, not colours.
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      return { bitmap, i };
    }),
  ).then((loaded) => {
    for (const { bitmap, i } of loaded) {
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(bitmap, 0, 0, size, size);
      data.set(ctx.getImageData(0, 0, size, size).data, (i + 1) * size * size * 4);
      bitmap.close();
    }
  });

  const tex = new THREE.DataArrayTexture(data, size, size, layers);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  tex.name = 'stone-normal-array';
  return tex;
}
