import { describe, expect, it } from 'vitest';
import { ChessGame } from '../src/chess/game';
import { frToSquare, squareAt, squareCentre, squareToFR, SQUARE } from '../src/game/squares';

function playAll(game: ChessGame, moves: string[]) {
  return moves.map((uci) => game.play(uci.slice(0, 2), uci.slice(2, 4), (uci[4] as 'q' | 'r' | 'b' | 'n' | undefined) ?? undefined));
}

describe('squares', () => {
  it('round-trips names and coordinates', () => {
    expect(squareToFR('a1')).toEqual([0, 0]);
    expect(squareToFR('h8')).toEqual([7, 7]);
    expect(frToSquare(4, 3)).toBe('e4');
    for (const sq of ['a1', 'e4', 'h8', 'c6']) {
      const p = squareCentre(sq);
      expect(squareAt(p.x, p.z)).toBe(sq);
    }
  });

  it('puts White at +z and files along +x', () => {
    expect(squareCentre('a1').z).toBeGreaterThan(0);
    expect(squareCentre('a8').z).toBeLessThan(0);
    expect(squareCentre('h1').x - squareCentre('a1').x).toBeCloseTo(SQUARE * 7);
    expect(squareAt(100, 0)).toBeNull();
  });
});

describe('ChessGame move events', () => {
  it('describes a plain capture', () => {
    const g = new ChessGame();
    const [, , capture] = playAll(g, ['e2e4', 'd7d5', 'e4d5']);
    expect(capture.captured).toBe('p');
    expect(capture.capturedSquare).toBe('d5');
    expect(capture.enPassant).toBe(false);
    expect(capture.castle).toBeUndefined();
  });

  it('describes en passant with the captured pawn beside the mover', () => {
    const g = new ChessGame();
    const events = playAll(g, ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6']);
    const ep = events[4];
    expect(ep.enPassant).toBe(true);
    expect(ep.captured).toBe('p');
    expect(ep.to).toBe('d6');
    expect(ep.capturedSquare).toBe('d5');
  });

  it('describes both castles for both sides', () => {
    const g = new ChessGame();
    g.load('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const wk = g.play('e1', 'g1');
    expect(wk.castle).toEqual({ rookFrom: 'h1', rookTo: 'f1', side: 'k' });
    const bq = g.play('e8', 'c8');
    expect(bq.castle).toEqual({ rookFrom: 'a8', rookTo: 'd8', side: 'q' });
    g.load('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(g.play('e1', 'c1').castle).toEqual({ rookFrom: 'a1', rookTo: 'd1', side: 'q' });
    expect(g.play('e8', 'g8').castle).toEqual({ rookFrom: 'h8', rookTo: 'f8', side: 'k' });
  });

  it('describes promotion, with and without capture', () => {
    const g = new ChessGame();
    g.load('1n5k/P7/8/8/8/8/8/K7 w - - 0 1');
    const targets = g.targets('a7');
    expect(targets.find((t) => t.to === 'a8')?.promotion).toBe(true);
    expect(targets.find((t) => t.to === 'b8')?.capture).toBe(true);
    const promo = g.play('a7', 'b8', 'n');
    expect(promo.promotion).toBe('n');
    expect(promo.captured).toBe('n');
    expect(promo.capturedSquare).toBe('b8');
    expect(() => {
      const h = new ChessGame();
      h.load('7k/P7/8/8/8/8/8/K7 w - - 0 1');
      h.play('a7', 'a8');
    }).toThrow();
  });

  it('reports check, checkmate and stalemate', () => {
    const g = new ChessGame();
    const events = playAll(g, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    expect(events[3].check).toBe(true);
    expect(events[3].checkmate).toBe(true);
    expect(g.status().over).toBe(true);
    expect(g.status().checkedKing).toBe('e1');

    const s = new ChessGame();
    s.load('7k/5Q2/8/8/8/8/8/K7 w - - 0 1');
    const stale = s.play('f7', 'g6');
    expect(stale.checkmate).toBe(false);
    expect(stale.draw).toBe('stalemate');
  });

  it('rejects illegal moves and lists targets only for the side to move', () => {
    const g = new ChessGame();
    expect(() => g.play('e2', 'e5')).toThrow();
    expect(g.targets('e7')).toEqual([]);
    expect(g.targets('e2').map((t) => t.to).sort()).toEqual(['e3', 'e4']);
  });

  it('undo restores the position', () => {
    const g = new ChessGame();
    const before = g.fen();
    g.play('e2', 'e4');
    expect(g.undo()?.san).toBe('e4');
    expect(g.fen()).toBe(before);
    expect(g.undo()).toBeNull();
  });
});

describe('ChessGame.legalUci (validating engine moves)', () => {
  it('accepts legal moves and rejects illegal or wrong-side ones', () => {
    const g = new ChessGame();
    expect(g.legalUci('e2e4')?.san).toBe('e4');
    expect(g.legalUci('g1f3')?.san).toBe('Nf3');
    expect(g.legalUci('e2e5')).toBeNull();
    expect(g.legalUci('e7e5')).toBeNull(); // Black's move on White's turn
    expect(g.legalUci('e3e4')).toBeNull(); // empty square
    expect(g.legalUci('nonsense')).toBeNull();
  });

  it('needs the promotion piece, and only for a promotion', () => {
    const g = new ChessGame();
    g.load('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    expect(g.legalUci('a7a8')).toBeNull();
    expect(g.legalUci('a7a8q')?.promotion).toBe('q');
    expect(g.legalUci('a7a8n')?.promotion).toBe('n');
    expect(g.legalUci('e1e2q')).toBeNull();
  });

  it('finds castling and en passant', () => {
    const g = new ChessGame();
    g.load('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
    expect(g.legalUci('e1g1')?.isKingsideCastle()).toBe(true);
    expect(g.legalUci('e1c1')?.isQueensideCastle()).toBe(true);
    g.load('4k3/7p/8/3pP3/8/8/P7/4K3 w - d6 0 1');
    expect(g.legalUci('e5d6')?.isEnPassant()).toBe(true);
  });
});
