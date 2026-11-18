// Fingers on the board, turned into the camera's gestures. Fed pointer positions by id, it
// answers with movements: one finger turns the view, two fingers zoom and slide it. It knows
// nothing of the camera or the DOM.

export interface OrbitDelta {
  kind: 'orbit';
  /** Movement of the finger since the last report, in pixels. */
  dx: number;
  dy: number;
}

export interface PinchDelta {
  kind: 'pinch';
  /** Distance between the two fingers now, over what it was at the last report. */
  scale: number;
  /** Movement of the point midway between them, in pixels. */
  dx: number;
  dy: number;
  /** Where that midpoint is. */
  x: number;
  y: number;
}

export type GestureDelta = OrbitDelta | PinchDelta;

/** What a press turned out to be once the last finger has lifted. */
export interface PressEnd {
  /** A single finger that came down and up in one place: a tap, at (x, y). */
  tap: boolean;
  x: number;
  y: number;
}

interface Point {
  x: number;
  y: number;
}

export class TouchGestures {
  private readonly pointers = new Map<number, Point>();
  /** The one finger has travelled far enough to be a drag. */
  private dragging = false;
  /** A second finger has been down at some time during this press: it can no longer be a tap. */
  private spoiled = false;
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;
  private lastSpan = 0;

  /** `slop` is how far a finger may wander, in pixels, and still be tapping. */
  constructor(private readonly slop = 10) {}

  /** Fingers down now. */
  get count(): number {
    return this.pointers.size;
  }

  /** True once the press in progress (or the one just ended) has stopped being a tap. */
  get moved(): boolean {
    return this.dragging || this.spoiled;
  }

  down(id: number, x: number, y: number): void {
    if (this.pointers.size === 0) {
      this.dragging = false;
      this.spoiled = false;
      this.startX = x;
      this.startY = y;
    } else if (!this.pointers.has(id)) {
      this.spoiled = true;
    }
    this.pointers.set(id, { x, y });
    this.anchor();
  }

  move(id: number, x: number, y: number): GestureDelta | null {
    const p = this.pointers.get(id);
    if (!p) return null;
    p.x = x;
    p.y = y;
    if (this.pointers.size === 1) {
      if (!this.dragging && !this.spoiled) {
        if (Math.hypot(x - this.startX, y - this.startY) < this.slop) return null;
        // The drag begins here: the wander up to this point is not played back as a jump.
        this.dragging = true;
        this.lastX = x;
        this.lastY = y;
        return null;
      }
      const delta: OrbitDelta = { kind: 'orbit', dx: x - this.lastX, dy: y - this.lastY };
      this.lastX = x;
      this.lastY = y;
      return delta;
    }
    const [a, b] = this.firstTwo();
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const delta: PinchDelta = { kind: 'pinch', scale: this.lastSpan > 1 && span > 1 ? span / this.lastSpan : 1, dx: cx - this.lastX, dy: cy - this.lastY, x: cx, y: cy };
    this.lastSpan = span;
    this.lastX = cx;
    this.lastY = cy;
    return delta;
  }

  /** A finger lifts. Answers only when it was the last one down. */
  up(id: number): PressEnd | null {
    const p = this.pointers.get(id);
    if (!p) return null;
    this.pointers.delete(id);
    if (this.pointers.size > 0) {
      this.anchor();
      return null;
    }
    return { tap: !this.dragging && !this.spoiled, x: p.x, y: p.y };
  }

  /** The browser took a finger away (a system gesture, a call): whatever it was doing was no tap. */
  cancel(id: number): void {
    if (!this.pointers.delete(id)) return;
    this.spoiled = true;
    this.anchor();
  }

  /** Forget every finger (the page was hidden mid-gesture). */
  reset(): void {
    this.pointers.clear();
    this.spoiled = true;
  }

  /** Start measuring from where the fingers are now, so a finger arriving or leaving moves nothing. */
  private anchor(): void {
    if (this.pointers.size === 0) return;
    if (this.pointers.size === 1) {
      const [p] = this.pointers.values();
      this.lastX = p.x;
      this.lastY = p.y;
      return;
    }
    const [a, b] = this.firstTwo();
    this.lastSpan = Math.hypot(b.x - a.x, b.y - a.y);
    this.lastX = (a.x + b.x) / 2;
    this.lastY = (a.y + b.y) / 2;
  }

  private firstTwo(): [Point, Point] {
    const it = this.pointers.values();
    return [it.next().value as Point, it.next().value as Point];
  }
}
