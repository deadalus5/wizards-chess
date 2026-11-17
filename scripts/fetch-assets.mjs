#!/usr/bin/env node
// Downloads the CC0 assets the game uses into public/assets and writes CREDITS.md.
// Idempotent: files that already exist are skipped. Archives are cached in .cache/downloads.
//
//   node scripts/fetch-assets.mjs            fetch everything
//   node scripts/fetch-assets.mjs m2m audio  fetch only the named groups
//   node scripts/fetch-assets.mjs --force    re-download even if present

import { mkdir, writeFile, readFile, stat, copyFile, readdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public/assets');
const CACHE = path.join(ROOT, '.cache/downloads');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--'));
const UA = 'Mozilla/5.0 (Macintosh) asset-fetch';

// ---------------------------------------------------------------- helpers

async function exists(file) {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

async function download(url, dest, { headers = {}, retries = 3 } = {}) {
  if (!FORCE && (await exists(dest))) return false;
  await mkdir(path.dirname(dest), { recursive: true });
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const tmp = dest + '.part';
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      await run('mv', [tmp, dest]);
      return true;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
  throw lastError;
}

async function pool(items, limit, worker) {
  let next = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
      done++;
      if (done % 40 === 0) console.log(`    ${done}/${items.length}`);
    }
  });
  await Promise.all(runners);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Extract entries matching `wanted` (array of [zipEntry, destFile]) from a zip into place. */
async function extractFromZip(zipFile, wanted) {
  const stage = zipFile + '.extract';
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  for (const [entry, dest] of wanted) {
    if (!FORCE && (await exists(dest))) continue;
    // unzip treats [ ] * ? as wildcards, so escape them in the literal entry name
    const literal = entry.replace(/([\[\]\*\?])/g, '\\$1');
    await run('unzip', ['-o', '-q', zipFile, literal, '-d', stage]);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(stage, entry), dest);
  }
  await rm(stage, { recursive: true, force: true });
}

async function zipListing(zipFile) {
  const { stdout } = await run('unzip', ['-Z1', zipFile], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.split('\n').filter(Boolean);
}

// itch.io "name your own price" free download, the same requests the web page makes.
async function itchDownload(page, pickUpload, dest) {
  if (!FORCE && (await exists(dest))) return false;
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const call = async (url, init = {}) => {
    const res = await fetch(url, {
      ...init,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Cookie: cookieHeader(), ...(init.headers ?? {}) },
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res;
  };
  const csrfOf = (html) => {
    const m = html.match(/<meta name="csrf_token" value="([^"]+)"/);
    if (!m) throw new Error('itch.io: csrf token not found');
    return m[1];
  };
  const form = (obj) => ({
    method: 'POST',
    body: new URLSearchParams(obj).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
  });

  const html1 = await (await call(page)).text();
  const { url: downloadPage } = await (await call(`${page}/download_url`, form({ csrf_token: csrfOf(html1) }))).json();
  const html2 = await (await call(downloadPage)).text();
  const uploads = [...html2.matchAll(/data-upload_id="(\d+)"/g)].map((m) => m[1]);
  if (!uploads.length) throw new Error('itch.io: no uploads listed');
  const uploadId = pickUpload(uploads);
  const signed = await (
    await call(`${page}/file/${uploadId}?source=game_download`, form({ csrf_token: csrfOf(html2) }))
  ).json();
  if (!signed.url) throw new Error(`itch.io: no signed url (${JSON.stringify(signed).slice(0, 200)})`);
  console.log(`    downloading ${path.basename(dest)} from itch.io ...`);
  return download(signed.url, dest, { retries: 1 });
}

/** Remove texture references from a .gltf: the game binds its own maps and must not fetch others. */
async function stripGltfTextures(file) {
  const gltf = JSON.parse(await readFile(file, 'utf8'));
  delete gltf.images;
  delete gltf.textures;
  delete gltf.samplers;
  for (const m of gltf.materials ?? []) {
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture;
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    }
    delete m.extensions;
  }
  await writeFile(file, JSON.stringify(gltf));
}

// ---------------------------------------------------------------- groups

const M2M_SHA = '5d6918ef67203e68c661b3e32e8e8f227bfd953e';
const M2M = `https://raw.githubusercontent.com/Mesh2Motion/mesh2motion-app/${M2M_SHA}/static/assets`;
const PROPS = [
  'sword_A', 'sword_B', 'sword_C', 'sword_D', 'sword_E', 'sword_F', 'odache', 'dagger_A', 'dagger_B',
  'hammer_A', 'hammer_B', 'hammer_C', 'axe_A', 'axe_B', 'axe_C', 'staff_A', 'staff_B', 'wand_A',
  'spear_A', 'halberd', 'shield_A', 'shield_B', 'shield_C',
];

const groups = {
  // Mesh2Motion: animation clips, reference rig, weapon props (CC0)
  async m2m() {
    const manifestFile = path.join(OUT, 'anim/manifest.json');
    await download(`${M2M}/manifest.json`, manifestFile);
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    const human = manifest.rigs.human;
    const jobs = [
      [`${M2M}/${human.model.file}`, path.join(OUT, 'models/m2m-human.glb')],
      [`${M2M}/${human.skeleton.file}`, path.join(OUT, 'models/m2m-skeleton.glb')],
      ...human.animations.map((a) => [`${M2M}/${a.file}`, path.join(OUT, 'anim/human', path.basename(a.file))]),
      ...PROPS.map((p) => [`${M2M}/props/${p}.glb`, path.join(OUT, 'props', `${p}.glb`)]),
    ];
    await pool(jobs, 8, ([url, dest]) => download(url, dest));
  },

  // Quaternius Universal Base Characters (CC0): heroic bodies, hair, beard.
  // Preferred source is the official itch.io download (original 2048px textures); if itch.io
  // refuses (it rate-limits), fall back to a GitHub mirror with recompressed textures.
  async quaternius() {
    const dest = path.join(OUT, 'models/superhero');
    const sourceFile = path.join(dest, 'SOURCE.txt');
    if (!FORCE && (await exists(sourceFile))) return;
    let source;
    try {
      const zip = path.join(CACHE, 'quaternius-ubc/universal-base-characters.zip');
      await itchDownload('https://quaternius.itch.io/universal-base-characters', (u) => u[0], zip);
      const listing = await zipListing(zip);
      await writeFile(path.join(CACHE, 'quaternius-ubc/listing.txt'), listing.join('\n'));
      const wanted = [];
      const take = (pattern) => {
        const hits = listing.filter((e) => pattern.test(e) && !e.endsWith('/'));
        if (!hits.length) throw new Error(`nothing in the zip matches ${pattern}`);
        for (const e of hits) wanted.push([e, path.join(dest, path.basename(e))]);
      };
      take(/Godot[^/]*\/Superhero_(Male|Female)_FullBody\.(gltf|bin)$/);
      take(/Godot[^/]*\/T_[^/]*\.png$/i);
      take(/Rigged to Head Bone\/glTF[^/]*\/(Hair|Eyebrows)_[^/]*\.(gltf|bin)$/i);
      await extractFromZip(zip, wanted);
      source = 'itch.io (original textures)';
    } catch (err) {
      console.warn(`    itch.io download failed (${err.message}); using the GitHub mirror`);
      const sha = '133933697eb8d966462a13a14a4219de6987fdc2';
      const base = `https://raw.githubusercontent.com/kirbycope/godot-3d-player-controller-v2/${sha}/assets/universal_base_characters`;
      const baseFiles = [
        'Superhero_Female_FullBody.bin', 'Superhero_Female_FullBody.gltf',
        'Superhero_Male_FullBody.bin', 'Superhero_Male_FullBody.gltf',
        'T_Eye_Brown.png', 'T_Eye_Normal.png', 'T_Hair_1_BaseColor.png', 'T_Hair_1_Normal.png',
        'T_Hair_2_BaseColor.png', 'T_Hair_2_Normal.png', 'T_Superhero_Female_Dark_BaseColor.png',
        'T_Superhero_Female_Normal.png', 'T_Superhero_Female_Roughness.png', 'T_Superhero_Male_Dark.png',
        'T_Superhero_Male_Normal.png', 'T_Superhero_Male_Roughness.png',
      ];
      const hair = ['Eyebrows_Female', 'Eyebrows_Regular', 'Hair_Beard', 'Hair_Buns', 'Hair_Buzzed', 'Hair_BuzzedFemale', 'Hair_Long', 'Hair_SimpleParted'];
      const jobs = [
        ...baseFiles.map((f) => [`${base}/${encodeURIComponent('Base Characters')}/${f}`, path.join(dest, f)]),
        ...hair.flatMap((h) => ['gltf', 'bin'].map((ext) => [`${base}/Hairstyles/Rigged/${h}.${ext}`, path.join(dest, `${h}.${ext}`)])),
      ];
      await pool(jobs, 6, ([url, file]) => download(url, file));
      source = `GitHub mirror kirbycope/godot-3d-player-controller-v2@${sha.slice(0, 10)} (recompressed textures)`;
    }
    // The game loads the normal maps itself; strip texture references so the glTF loader
    // does not fetch (or fail on) images it does not need.
    for (const name of await readdir(dest)) {
      if (name.endsWith('.gltf')) await stripGltfTextures(path.join(dest, name));
    }
    await writeFile(sourceFile, source + '\n');
    console.log(`    source: ${source}`);
  },

  // Poly Haven (CC0): chess set model, HDRIs, PBR textures
  async polyhaven() {
    const jobs = [];
    const files = await getJson('https://api.polyhaven.com/files/chess_set');
    const gltf = files.gltf['2k'].gltf;
    jobs.push([gltf.url, path.join(OUT, 'models/chess_set/chess_set.gltf')]);
    for (const [name, f] of Object.entries(gltf.include)) {
      if (/board/.test(name) || /_diff_|_arm_/.test(name)) continue; // only geometry + piece normal maps
      jobs.push([f.url, path.join(OUT, 'models/chess_set', name)]);
    }
    for (const id of ['sepulchral_chapel_basement', 'rostock_arches', 'castle_zavelstein_cellar']) {
      jobs.push([
        `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/${id}_2k.hdr`,
        path.join(OUT, 'hdr', `${id}_2k.hdr`),
      ]);
    }
    const tex = { marble_01: '2k', monastery_stone_floor: '2k', medieval_blocks_05: '2k', dark_rock: '1k', slate_floor: '2k' };
    for (const [id, res] of Object.entries(tex)) {
      for (const map of ['diff', 'nor_gl', 'arm']) {
        jobs.push([
          `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/${res}/${id}/${id}_${map}_${res}.jpg`,
          path.join(OUT, 'textures', id, `${map}.jpg`),
        ]);
      }
    }
    await pool(jobs, 6, ([url, dest]) => download(url, dest));
    await stripGltfTextures(path.join(OUT, 'models/chess_set/chess_set.gltf'));
  },

  // ambientCG (CC0): dark and light marbles
  async ambientcg() {
    for (const id of ['Marble009', 'Marble016', 'Marble006', 'Marble021', 'Marble014']) {
      const zip = path.join(CACHE, `ambientcg-${id}/${id}_2K-JPG.zip`);
      await download(`https://ambientcg.com/get?file=${id}_2K-JPG.zip`, zip);
      const listing = await zipListing(zip);
      const wanted = [];
      for (const [suffix, name] of [['Color', 'diff'], ['NormalGL', 'nor_gl'], ['Roughness', 'rough']]) {
        const entry = listing.find((e) => e.endsWith(`_${suffix}.jpg`));
        if (entry) wanted.push([entry, path.join(OUT, 'textures', id, `${name}.jpg`)]);
        else console.warn(`    WARNING: ${id} has no ${suffix} map`);
      }
      await extractFromZip(zip, wanted);
    }
  },
};

// ---------------------------------------------------------------- credits

const CREDITS = `# Credits

All third-party assets in \`public/assets\` are released under CC0 1.0 (public domain dedication).
No attribution is required; the creators are credited here with thanks.

| Asset | Creator | Source |
|---|---|---|
| Human animation library, reference rig | Mesh2Motion contributors (many clips retargeted from Quaternius) | https://github.com/Mesh2Motion/mesh2motion-app (commit ${M2M_SHA.slice(0, 10)}) |
| Fantasy weapon props | Kay Lousberg (KayKit), via Mesh2Motion | https://kaylousberg.com |
| Universal Base Characters (bodies, hair) | Quaternius | https://quaternius.com/packs/universalbasecharacters.html |
| Chess Set model | Riley Queen / Poly Haven | https://polyhaven.com/a/chess_set |
| HDRIs and PBR textures | Poly Haven | https://polyhaven.com |
| Marble textures | ambientCG | https://ambientcg.com |
| Sound effects | Kenney; OpenGameArt contributors | https://kenney.nl, https://opengameart.org |

Quaternius and Kay Lousberg offer their packs free of charge and accept support on their own sites.
`;

// ---------------------------------------------------------------- main

const selected = only.length ? only : Object.keys(groups);
for (const name of selected) {
  if (!groups[name]) {
    console.error(`unknown group "${name}" (have: ${Object.keys(groups).join(', ')})`);
    process.exit(1);
  }
  console.log(`[${name}]`);
  await groups[name]();
}
await writeFile(path.join(ROOT, 'CREDITS.md'), CREDITS);

let bytes = 0;
let count = 0;
async function tally(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await tally(p);
    else {
      bytes += (await stat(p)).size;
      count++;
    }
  }
}
await tally(OUT);
console.log(`done: ${count} files, ${(bytes / 1e6).toFixed(1)} MB in public/assets`);
