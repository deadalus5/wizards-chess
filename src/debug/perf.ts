/**
 * Frame timing: requestAnimationFrame intervals saturate at the display refresh, so they
 * cannot show headroom. This records CPU time spent in the frame callback and, where the
 * browser exposes timer queries, GPU time for the rendered frame.
 */
export class GpuTimer {
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  /** Most recent completed measurement, in milliseconds (0 until the first result arrives). */
  lastMs = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  get supported(): boolean {
    return this.ext !== null;
  }

  begin(): void {
    if (!this.ext || this.active || this.pending.length > 8) return;
    this.active = this.gl.createQuery();
    if (this.active) this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.active);
  }

  end(): void {
    if (!this.ext) return;
    if (this.active) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.pending.push(this.active);
      this.active = null;
    }
    const gl = this.gl;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
      if (!disjoint) this.lastMs = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
      gl.deleteQuery(q);
      this.pending.shift();
    }
  }
}

export interface FrameSample {
  /** Time since the previous rendered frame, ms. */
  interval: number;
  cpu: number;
  gpu: number;
}

export interface PerfReport {
  frames: number;
  seconds: number;
  fps: number;
  interval: Stat;
  cpu: Stat;
  gpu: Stat;
  /** Frames whose interval exceeded 1.5x the median. */
  hitches: number;
  worstInterval: number;
}

interface Stat {
  median: number;
  p95: number;
  p99: number;
  max: number;
}

function stat(values: number[]): Stat {
  if (!values.length) return { median: 0, p95: 0, p99: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number): number => +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(2);
  return { median: at(0.5), p95: at(0.95), p99: at(0.99), max: +s[s.length - 1].toFixed(2) };
}

export class PerfRecorder {
  private samples: FrameSample[] | null = null;
  private started = 0;

  get recording(): boolean {
    return this.samples !== null;
  }

  start(): void {
    this.samples = [];
    this.started = performance.now();
  }

  push(sample: FrameSample): void {
    this.samples?.push(sample);
  }

  stop(): PerfReport {
    const samples = this.samples ?? [];
    this.samples = null;
    const seconds = (performance.now() - this.started) / 1000;
    const intervals = samples.map((s) => s.interval);
    const interval = stat(intervals);
    return {
      frames: samples.length,
      seconds: +seconds.toFixed(2),
      fps: +(samples.length / Math.max(seconds, 1e-3)).toFixed(1),
      interval,
      cpu: stat(samples.map((s) => s.cpu)),
      gpu: stat(samples.map((s) => s.gpu).filter((g) => g > 0)),
      hitches: intervals.filter((v) => v > interval.median * 1.5).length,
      worstInterval: interval.max,
    };
  }

  /** Record for `seconds` of wall-clock time and resolve with the report. */
  measure(seconds: number): Promise<PerfReport> {
    this.start();
    return new Promise((resolve) => setTimeout(() => resolve(this.stop()), seconds * 1000));
  }
}
