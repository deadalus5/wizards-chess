import { describe, expect, it } from 'vitest';
import { TouchGestures, type PinchDelta } from '../src/input/gestures';

describe('TouchGestures', () => {
  it('calls a finger that comes down and up in one place a tap', () => {
    const g = new TouchGestures(10);
    g.down(1, 100, 200);
    expect(g.move(1, 103, 204)).toBeNull();
    expect(g.up(1)).toEqual({ tap: true, x: 103, y: 204 });
    expect(g.count).toBe(0);
  });

  it('turns a finger that travels into an orbit drag, without replaying the wander that started it', () => {
    const g = new TouchGestures(10);
    g.down(1, 100, 100);
    expect(g.move(1, 106, 100)).toBeNull();
    // Crossing the slop starts the drag; it moves nothing itself.
    expect(g.move(1, 114, 100)).toBeNull();
    expect(g.moved).toBe(true);
    expect(g.move(1, 124, 97)).toEqual({ kind: 'orbit', dx: 10, dy: -3 });
    expect(g.move(1, 120, 97)).toEqual({ kind: 'orbit', dx: -4, dy: 0 });
    expect(g.up(1)?.tap).toBe(false);
  });

  it('reads two fingers as a pinch about their midpoint', () => {
    const g = new TouchGestures();
    g.down(1, 100, 300);
    g.down(2, 200, 300);
    const out = g.move(2, 300, 300) as PinchDelta;
    expect(out.kind).toBe('pinch');
    expect(out.scale).toBeCloseTo(2, 6);
    expect(out.dx).toBeCloseTo(50, 6);
    expect(out.dy).toBeCloseTo(0, 6);
    expect([out.x, out.y]).toEqual([200, 300]);
    // Both fingers sliding together (the browser reports them one at a time): between them
    // the two reports add up to no zoom and the whole movement.
    const first = g.move(1, 100, 340) as PinchDelta;
    const second = g.move(2, 300, 340) as PinchDelta;
    expect(first.scale * second.scale).toBeCloseTo(1, 6);
    expect(first.dy + second.dy).toBeCloseTo(40, 6);
    expect(first.dx + second.dx).toBeCloseTo(0, 6);
  });

  it('never taps once a second finger has been down', () => {
    const g = new TouchGestures();
    g.down(1, 100, 100);
    g.down(2, 180, 100);
    expect(g.up(2)).toBeNull();
    expect(g.up(1)).toEqual({ tap: false, x: 100, y: 100 });
  });

  it('does not jump when a finger arrives or leaves', () => {
    const g = new TouchGestures(10);
    g.down(1, 100, 100);
    g.move(1, 140, 100);
    g.move(1, 150, 100);
    g.down(2, 300, 100);
    // The first report after the second finger lands measures from where both are now.
    const first = g.move(1, 150, 100) as PinchDelta;
    expect(first.scale).toBeCloseTo(1, 6);
    expect(first.dx).toBeCloseTo(0, 6);
    g.up(1);
    // The finger left behind carries on from where it is, as an orbit.
    expect(g.move(2, 310, 104)).toEqual({ kind: 'orbit', dx: 10, dy: 4 });
  });

  it('treats a finger the browser took away as no tap, and carries on with what is left', () => {
    const g = new TouchGestures();
    g.down(1, 50, 50);
    g.cancel(1);
    expect(g.count).toBe(0);
    expect(g.moved).toBe(true);
    expect(g.up(1)).toBeNull();
    // A fresh press afterwards is judged on its own.
    g.down(3, 10, 10);
    expect(g.up(3)?.tap).toBe(true);
  });

  it('ignores pointers it was never told about', () => {
    const g = new TouchGestures();
    expect(g.move(9, 1, 1)).toBeNull();
    expect(g.up(9)).toBeNull();
  });
});
