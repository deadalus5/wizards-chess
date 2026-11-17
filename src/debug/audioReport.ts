import { Synth } from '../audio/synth';

/** In-place radix-2 FFT. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const SOUNDS: Record<string, [number, (s: Synth, t: number) => void]> = {
  'footstep light': [0.8, (s, t) => s.footstep(t, 0.2)],
  'footstep heavy': [0.9, (s, t) => s.footstep(t, 1)],
  'grind 2 s': [2.8, (s, t) => void s.grind(t, 2, 1)],
  landing: [1.4, (s, t) => s.landing(t, 0.8)],
  whoosh: [0.9, (s, t) => s.whoosh(t, 1)],
  'impact stagger': [1.6, (s, t) => s.impact(t, 0.45)],
  'impact kill': [1.8, (s, t) => s.impact(t, 1)],
  shatter: [2.6, (s, t) => s.shatter(t)],
  'kill (impact + shatter)': [2.8, (s, t) => (s.impact(t, 1), s.shatter(t))],
  dissolve: [2.6, (s, t) => s.dissolve(t)],
  select: [1.2, (s, t) => s.select(t)],
  'check bell': [3.4, (s, t) => s.bell(t)],
  finale: [5.5, (s, t) => s.finale(t)],
  ascend: [2.6, (s, t) => s.ascend(t)],
  'ambience 4s': [4, (s, t) => void s.ambience(t, 3.9)],
};

/**
 * Render every sound offline and measure it: peak and RMS level (dBFS), how long it lasts,
 * where its energy sits in frequency. Also draws a spectrogram of each into a canvas laid
 * over the page, so the shapes can be looked at. The machine this was built on cannot
 * listen; this is the next best thing.
 */
export async function audioReport(): Promise<unknown> {
  const rate = 48000;
  const rows: Record<string, unknown>[] = [];
  const W = 300;
  const H = 120;
  const names = Object.keys(SOUNDS);
  const cols = 5;
  const canvas = document.createElement('canvas');
  canvas.id = 'audio-report';
  canvas.width = cols * (W + 8);
  canvas.height = Math.ceil(names.length / cols) * (H + 26);
  canvas.style.cssText = 'position:fixed;left:0;top:0;z-index:999;background:#000';
  document.getElementById('audio-report')?.remove();
  document.body.append(canvas);
  const g = canvas.getContext('2d')!;
  g.font = '12px monospace';

  for (const [index, name] of names.entries()) {
    const [seconds, play] = SOUNDS[name];
    const ctx = new OfflineAudioContext(2, Math.floor(rate * seconds), rate);
    play(new Synth(ctx), 0.05);
    const buffer = await ctx.startRendering();
    const L = buffer.getChannelData(0);
    const R = buffer.getChannelData(1);
    let peak = 0;
    let sum = 0;
    let peakAt = 0;
    let lastLoud = 0;
    for (let i = 0; i < L.length; i++) {
      const v = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (v > peak) {
        peak = v;
        peakAt = i;
      }
      if (v > 0.003) lastLoud = i;
      sum += (L[i] * L[i] + R[i] * R[i]) / 2;
    }
    const db = (x: number): number => +(20 * Math.log10(Math.max(x, 1e-6))).toFixed(1);

    // Spectrogram and spectral centroid.
    const N = 1024;
    const hop = Math.max(1, Math.floor(L.length / W));
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    let weighted = 0;
    let total = 0;
    const x0 = (index % cols) * (W + 8);
    const y0 = Math.floor(index / cols) * (H + 26) + 16;
    g.fillStyle = '#ddd';
    g.fillText(`${name}  ${db(peak)} dB`, x0 + 2, y0 - 4);
    for (let col = 0; col < W; col++) {
      const start = col * hop;
      for (let i = 0; i < N; i++) {
        const s = start + i < L.length ? L[start + i] : 0;
        re[i] = s * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
        im[i] = 0;
      }
      fft(re, im);
      for (let row = 0; row < H; row++) {
        // Log frequency axis from 30 Hz to 16 kHz.
        const f = 30 * Math.pow(16000 / 30, 1 - row / (H - 1));
        const bin = Math.min(N / 2 - 1, Math.round((f / rate) * N));
        const mag = Math.hypot(re[bin], im[bin]) / (N / 4);
        const level = Math.max(0, Math.min(1, (20 * Math.log10(mag + 1e-7) + 80) / 80));
        g.fillStyle = `hsl(${40 - 40 * level}, 90%, ${Math.round(level * 62)}%)`;
        g.fillRect(x0 + col, y0 + row, 1, 1);
      }
      for (let bin = 1; bin < N / 2; bin++) {
        const p = re[bin] * re[bin] + im[bin] * im[bin];
        weighted += p * ((bin * rate) / N);
        total += p;
      }
    }
    rows.push({ name, peakDb: db(peak), rmsDb: db(Math.sqrt(sum / L.length)), peakAtMs: Math.round((peakAt / rate) * 1000), endsMs: Math.round((lastLoud / rate) * 1000), centroidHz: Math.round(weighted / Math.max(total, 1e-12)) });
  }
  return rows;
}
