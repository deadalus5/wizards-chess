/**
 * Every sound in the game is synthesised: filtered noise and a few sine partials through a
 * generated hall reverb. No samples to download or license, and each sound can be shaped to
 * the event that causes it (a heavier statue makes a lower, longer footfall).
 *
 * The synth works on any BaseAudioContext, so the same code can be rendered offline and
 * measured (the build machine has no ears; see the audio report in the debug API).
 */

interface NoiseOptions {
  type: BiquadFilterType;
  freq: number;
  /** Sweep the filter to this frequency over the sound. */
  freqEnd?: number;
  q?: number;
  attack?: number;
  decay: number;
  gain: number;
}

interface ToneOptions {
  freq: number;
  freqEnd?: number;
  attack?: number;
  decay: number;
  gain: number;
  type?: OscillatorType;
}

const SILENT = 0.0001;
/** Levels inside the grind: the low rumble, the gritty band, and how far the grit's level wanders. */
const GRIND = { body: 0.5, grit: 0.1, wander: 1.6 };
const rand = (lo: number, hi: number): number => lo + (hi - lo) * Math.random();

export class Synth {
  /** Everything goes through here; fade it to mute. */
  readonly master: GainNode;
  private readonly dry: GainNode;
  private readonly send: GainNode;
  private readonly noise: AudioBuffer;

  constructor(readonly ctx: BaseAudioContext) {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 10;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.22;
    limiter.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(limiter);

    this.dry = ctx.createGain();
    this.dry.connect(this.master);
    const reverb = ctx.createConvolver();
    reverb.buffer = this.hallImpulse(3.4);
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    this.send = ctx.createGain();
    // Keep the lowest octaves out of the hall, or every footfall leaves a boom behind it.
    const clear = ctx.createBiquadFilter();
    clear.type = 'highpass';
    clear.frequency.value = 170;
    this.send.connect(clear);
    clear.connect(reverb);
    reverb.connect(wet);
    wet.connect(this.master);

    // Two seconds of white noise, shared by every noise voice (each starts at a random offset).
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  /** A large stone hall: a few early reflections, then a long tail that darkens as it decays. */
  private hallImpulse(seconds: number): AudioBuffer {
    const { ctx } = this;
    const length = Math.floor(ctx.sampleRate * seconds);
    const ir = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      let low = 0;
      for (let i = 0; i < length; i++) {
        const t = i / ctx.sampleRate;
        // The tail loses its top end over time, as air and stone absorb it.
        const cutoff = 0.5 * Math.exp(-t * 1.5) + 0.035;
        low += cutoff * (Math.random() * 2 - 1 - low);
        d[i] = low * Math.exp(-t / 0.82) * Math.min(1, t / 0.012);
      }
      for (const [at, gain] of [
        [0.019, 0.5],
        [0.033, -0.38],
        [0.047, 0.3],
        [0.071, -0.22],
      ]) {
        const i = Math.floor((at + c * 0.004) * ctx.sampleRate);
        if (i < length) d[i] += gain;
      }
    }
    return ir;
  }

  /** A place in the mix for one event: pan, level with distance, and how much hall it gets. */
  private voice(pan: number, level: number, hall: number): GainNode {
    const { ctx } = this;
    const out = ctx.createGain();
    out.gain.value = level;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(panner);
    panner.connect(this.dry);
    const toHall = ctx.createGain();
    toHall.gain.value = hall;
    panner.connect(toHall);
    toHall.connect(this.send);
    return out;
  }

  private burst(dest: AudioNode, when: number, o: NoiseOptions): void {
    const { ctx } = this;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = o.type;
    filter.Q.value = o.q ?? 0.8;
    filter.frequency.setValueAtTime(o.freq, when);
    const attack = o.attack ?? 0.002;
    if (o.freqEnd) filter.frequency.exponentialRampToValueAtTime(o.freqEnd, when + attack + o.decay);
    const env = ctx.createGain();
    env.gain.setValueAtTime(SILENT, when);
    env.gain.exponentialRampToValueAtTime(o.gain, when + attack);
    env.gain.exponentialRampToValueAtTime(SILENT, when + attack + o.decay);
    src.connect(filter);
    filter.connect(env);
    env.connect(dest);
    src.start(when, Math.random() * 1.5);
    src.stop(when + attack + o.decay + 0.05);
  }

  private tone(dest: AudioNode, when: number, o: ToneOptions): void {
    const { ctx } = this;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, when);
    const attack = o.attack ?? 0.003;
    if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(o.freqEnd, when + attack + o.decay);
    const env = ctx.createGain();
    env.gain.setValueAtTime(SILENT, when);
    env.gain.exponentialRampToValueAtTime(o.gain, when + attack);
    env.gain.exponentialRampToValueAtTime(SILENT, when + attack + o.decay);
    osc.connect(env);
    env.connect(dest);
    osc.start(when);
    osc.stop(when + attack + o.decay + 0.05);
  }

  /** Stone foot on stone floor. `heft` 0..1: heavier is lower, longer and louder. */
  footstep(when: number, heft: number, pan = 0, level = 1): void {
    const v = this.voice(pan, level * (0.5 + 0.5 * heft), 0.32);
    // Weight: a low thump. It is the knock and the click above it that say "stone", and
    // that small speakers can actually reproduce.
    const base = 150 - 60 * heft;
    this.tone(v, when, { freq: base, freqEnd: base * 0.55, decay: 0.06 + 0.07 * heft, gain: 0.3 });
    this.tone(v, when, { freq: rand(330, 430) - 90 * heft, decay: 0.035, gain: 0.2 });
    this.burst(v, when, { type: 'bandpass', freq: rand(1500, 2300), q: 1.4, decay: 0.03, gain: 0.3 });
    this.burst(v, when, { type: 'lowpass', freq: 700, decay: 0.08, gain: 0.12 });
  }

  /** A statue coming down from a leap, or settling from a glide. */
  landing(when: number, heft: number, pan = 0, level = 1): void {
    const v = this.voice(pan, level * (0.55 + 0.45 * heft), 0.5);
    this.tone(v, when, { freq: 84, freqEnd: 36, decay: 0.3, gain: 0.7 });
    this.burst(v, when, { type: 'lowpass', freq: 380, decay: 0.26, gain: 0.34 });
    this.burst(v, when, { type: 'bandpass', freq: 1700, q: 1, decay: 0.05, gain: 0.2 });
  }

  /**
   * Stone dragged over stone, for `seconds`: a low rumble with grit in it that catches and
   * lets go, swelling in and dying away. Returns a handle that cuts it short (a move skipped
   * or abandoned).
   */
  grind(when: number, seconds: number, heft: number, pan = 0, level = 1): { stop(): void } {
    const { ctx } = this;
    const v = this.voice(pan, level * (0.55 + 0.45 * heft), 0.28);
    const out = ctx.createGain();
    const swell = Math.min(0.45, seconds * 0.35);
    const fade = Math.min(0.5, seconds * 0.4);
    out.gain.setValueAtTime(SILENT, when);
    out.gain.exponentialRampToValueAtTime(1, when + swell);
    out.gain.setValueAtTime(1, when + Math.max(swell, seconds - fade));
    out.gain.exponentialRampToValueAtTime(SILENT, when + seconds);
    out.connect(v);
    const sources: AudioBufferSourceNode[] = [];
    const noise = (): AudioBufferSourceNode => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.start(when, Math.random() * 1.5);
      src.stop(when + seconds + 0.1);
      sources.push(src);
      return src;
    };
    // The weight of it.
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = 200;
    body.Q.value = 0.7;
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = GRIND.body;
    noise().connect(body);
    body.connect(bodyGain);
    bodyGain.connect(out);
    // The grit: a band whose level wanders, so it never sounds like a machine.
    const grit = ctx.createBiquadFilter();
    grit.type = 'bandpass';
    grit.frequency.value = 610;
    grit.Q.value = 1.1;
    const gritGain = ctx.createGain();
    gritGain.gain.value = GRIND.grit;
    const wander = ctx.createBiquadFilter();
    wander.type = 'lowpass';
    wander.frequency.value = 7;
    const depth = ctx.createGain();
    depth.gain.value = GRIND.wander;
    noise().connect(wander);
    wander.connect(depth);
    depth.connect(gritGain.gain);
    noise().connect(grit);
    grit.connect(gritGain);
    gritGain.connect(out);
    return {
      stop: () => {
        const t = ctx.currentTime;
        out.gain.cancelScheduledValues(t);
        out.gain.setTargetAtTime(SILENT, t, 0.06);
        for (const src of sources) src.stop(t + 0.4);
      },
    };
  }

  /** A weapon cutting the air; ends at the blow. */
  whoosh(when: number, intensity: number, pan = 0, level = 1): void {
    const v = this.voice(pan, level, 0.25);
    const { ctx } = this;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.6;
    filter.frequency.setValueAtTime(280, when);
    filter.frequency.exponentialRampToValueAtTime(1500, when + 0.17);
    filter.frequency.exponentialRampToValueAtTime(420, when + 0.34);
    const env = ctx.createGain();
    env.gain.setValueAtTime(SILENT, when);
    env.gain.exponentialRampToValueAtTime(0.42 * intensity, when + 0.16);
    env.gain.exponentialRampToValueAtTime(SILENT, when + 0.36);
    src.connect(filter);
    filter.connect(env);
    env.connect(v);
    src.start(when, Math.random());
    src.stop(when + 0.42);
  }

  /** Weapon on stone. `strength` 1 is the blow that breaks the statue. */
  impact(when: number, strength: number, pan = 0, level = 1): void {
    const v = this.voice(pan, level * (0.45 + 0.55 * strength), 0.6);
    this.tone(v, when, { freq: 72, freqEnd: 31, decay: 0.5, gain: 0.8 });
    this.tone(v, when, { freq: 190, freqEnd: 84, decay: 0.16, gain: 0.5 });
    this.burst(v, when, { type: 'highpass', freq: 1300, decay: 0.07, gain: 0.5 });
    this.burst(v, when, { type: 'bandpass', freq: 520, q: 0.8, decay: 0.2, gain: 0.42 });
    // The weapon rings.
    for (const f of [1870, 2740, 4130]) this.tone(v, when, { freq: f * rand(0.92, 1.08), decay: rand(0.3, 0.6), gain: 0.045 });
  }

  /** A statue coming apart and its rubble meeting the floor, over a second or so. */
  shatter(when: number, pan = 0, level = 1): void {
    const v = this.voice(pan, level * 1.6, 0.55);
    this.burst(v, when, { type: 'lowpass', freq: 190, attack: 0.02, decay: 1.2, gain: 0.5 });
    this.burst(v, when, { type: 'bandpass', freq: 900, freqEnd: 300, q: 0.6, attack: 0.01, decay: 0.7, gain: 0.22 });
    // Fragments knocking together and landing: dense at first, then stragglers.
    for (let i = 0; i < 36; i++) {
      const u = Math.random();
      const at = when + 0.02 + 1.25 * u * u;
      const fade = 1 - 0.7 * u;
      this.burst(v, at, { type: 'bandpass', freq: rand(380, 3200), q: rand(2, 7), decay: rand(0.018, 0.06), gain: rand(0.07, 0.24) * fade });
      if (i % 3 === 0) this.tone(v, at, { freq: rand(140, 420), freqEnd: rand(80, 140), decay: rand(0.04, 0.09), gain: 0.16 * fade });
    }
  }

  /** Rubble crumbling away into light. */
  dissolve(when: number, pan = 0, level = 1): void {
    const v = this.voice(pan, level, 0.7);
    for (let i = 0; i < 10; i++) {
      this.tone(v, when + rand(0, 0.8), { freq: rand(1700, 5200), attack: rand(0.15, 0.4), decay: rand(0.6, 1.3), gain: 0.011 });
    }
    this.burst(v, when, { type: 'highpass', freq: 5200, attack: 0.3, decay: 1.2, gain: 0.02 });
  }

  /** A statue stirring as it is chosen. */
  select(when: number, pan = 0): void {
    const v = this.voice(pan, 1, 0.5);
    this.tone(v, when, { freq: 196, attack: 0.03, decay: 0.5, gain: 0.075 });
    this.tone(v, when, { freq: 294, attack: 0.05, decay: 0.4, gain: 0.05 });
    this.burst(v, when, { type: 'bandpass', freq: 2400, q: 2, decay: 0.03, gain: 0.045 });
  }

  /** A bell for check: inharmonic partials, as struck bronze has. */
  bell(when: number, pitch = 1, level = 1, seconds = 2.4): void {
    const v = this.voice(0, level, 0.75);
    const partials: [number, number][] = [
      [220, 1],
      [331, 0.6],
      [467, 0.45],
      [587, 0.3],
      [830, 0.2],
      [1109, 0.1],
    ];
    for (const [f, g] of partials) this.tone(v, when, { freq: f * pitch, attack: 0.004, decay: seconds * (0.5 + 0.5 * g), gain: 0.085 * g });
    this.burst(v, when, { type: 'bandpass', freq: 1800 * pitch, q: 1.5, decay: 0.03, gain: 0.05 });
  }

  /** The end of the game: a deep bell over a falling boom. */
  finale(when: number): void {
    this.bell(when, 0.5, 1.5, 4.5);
    const v = this.voice(0, 1, 0.7);
    this.tone(v, when, { freq: 55, freqEnd: 27, decay: 1.6, gain: 0.5 });
  }

  /** A pawn remade: a rising figure of soft tones. */
  ascend(when: number, pan = 0): void {
    const v = this.voice(pan, 1, 0.75);
    [392, 523, 659, 784, 1047].forEach((f, i) => {
      this.tone(v, when + i * 0.11, { freq: f, attack: 0.03, decay: 0.9, gain: 0.05 });
      this.tone(v, when + i * 0.11, { freq: f * 2.01, attack: 0.05, decay: 0.6, gain: 0.014 });
    });
    this.burst(v, when + 0.2, { type: 'highpass', freq: 4800, attack: 0.4, decay: 1, gain: 0.018 });
  }

  /** One crackle of a brazier. */
  crackle(when: number, pan: number): void {
    const v = this.voice(pan, 1, 0.3);
    this.burst(v, when, { type: 'bandpass', freq: rand(1800, 5200), q: rand(2, 5), decay: rand(0.006, 0.03), gain: rand(0.005, 0.018) });
  }

  /**
   * The hall itself: a very low drone and moving air. Runs until `stop` is called on what it
   * returns (or for `seconds` when rendering offline).
   */
  ambience(when: number, seconds?: number): { stop(): void } {
    const { ctx } = this;
    const out = ctx.createGain();
    out.gain.setValueAtTime(SILENT, when);
    out.gain.exponentialRampToValueAtTime(1, when + 3);
    out.connect(this.dry);
    const toHall = ctx.createGain();
    toHall.gain.value = 0.4;
    out.connect(toHall);
    toHall.connect(this.send);
    const stops: AudioScheduledSourceNode[] = [];
    for (const [f, g] of [
      [55, 0.02],
      [82.4, 0.014],
      [110.3, 0.008],
    ]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      const gain = ctx.createGain();
      gain.gain.value = g;
      // A slow swell, each partial at its own pace, so the drone breathes.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rand(0.05, 0.13);
      const depth = ctx.createGain();
      depth.gain.value = g * 0.5;
      lfo.connect(depth);
      depth.connect(gain.gain);
      osc.connect(gain);
      gain.connect(out);
      osc.start(when);
      lfo.start(when);
      stops.push(osc, lfo);
    }
    const air = ctx.createBufferSource();
    air.buffer = this.noise;
    air.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 300;
    const airGain = ctx.createGain();
    airGain.gain.value = 0.034;
    air.connect(lp);
    lp.connect(airGain);
    airGain.connect(out);
    air.start(when);
    stops.push(air);
    if (seconds !== undefined) for (const s of stops) s.stop(when + seconds);
    return {
      stop: () => {
        const t = ctx.currentTime;
        out.gain.cancelScheduledValues(t);
        out.gain.setTargetAtTime(SILENT, t, 0.3);
        for (const s of stops) s.stop(t + 2);
      },
    };
  }
}
