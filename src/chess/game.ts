import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js';

export type DrawReason = 'stalemate' | 'repetition' | 'insufficient material' | 'fifty-move rule';

/** Everything the presentation layer needs to know about one move. */
export interface MoveEvent {
  san: string;
  color: Color;
  piece: PieceSymbol;
  from: Square;
  to: Square;
  /** Type of the captured piece, if any. */
  captured?: PieceSymbol;
  /** Where the captured piece stood (differs from `to` for en passant). */
  capturedSquare?: Square;
  enPassant: boolean;
  promotion?: PieceSymbol;
  /** The rook's move when castling. */
  castle?: { rookFrom: Square; rookTo: Square; side: 'k' | 'q' };
  /** The side to move after this move is in check. */
  check: boolean;
  checkmate: boolean;
  draw: DrawReason | null;
  fenBefore: string;
  fenAfter: string;
}

export interface Target {
  to: Square;
  capture: boolean;
  promotion: boolean;
}

export interface GameStatus {
  turn: Color;
  check: boolean;
  checkmate: boolean;
  draw: DrawReason | null;
  over: boolean;
  /** Square of the king that is in check, if any. */
  checkedKing: Square | null;
}

/** Thin wrapper over chess.js: the single source of truth for the rules. */
export class ChessGame {
  private chess = new Chess();

  reset(): void {
    this.chess.reset();
  }

  load(fen: string): void {
    this.chess.load(fen);
  }

  fen(): string {
    return this.chess.fen();
  }

  turn(): Color {
    return this.chess.turn();
  }

  /** Rank 8 first, as chess.js returns it. */
  board(): ReturnType<Chess['board']> {
    return this.chess.board();
  }

  pieceAt(square: string): { type: PieceSymbol; color: Color } | undefined {
    return this.chess.get(square as Square);
  }

  history(): string[] {
    return this.chess.history();
  }

  /** Legal destinations for the piece on `square` (empty if it is not that side's turn). */
  targets(square: string): Target[] {
    const moves = this.chess.moves({ square: square as Square, verbose: true });
    const seen = new Map<string, Target>();
    for (const m of moves) {
      if (!seen.has(m.to)) seen.set(m.to, { to: m.to, capture: m.isCapture(), promotion: m.isPromotion() });
    }
    return [...seen.values()];
  }

  status(): GameStatus {
    const c = this.chess;
    const turn = c.turn();
    const check = c.isCheck();
    let checkedKing: Square | null = null;
    if (check) checkedKing = c.findPiece({ type: 'k', color: turn })[0] ?? null;
    return { turn, check, checkmate: c.isCheckmate(), draw: this.drawReason(), over: c.isGameOver(), checkedKing };
  }

  private drawReason(): DrawReason | null {
    const c = this.chess;
    if (c.isStalemate()) return 'stalemate';
    if (c.isInsufficientMaterial()) return 'insufficient material';
    if (c.isThreefoldRepetition()) return 'repetition';
    if (c.isDrawByFiftyMoves()) return 'fifty-move rule';
    return null;
  }

  /** Play a move. Throws if it is illegal (chess.js does); promotions need `promotion`. */
  play(from: string, to: string, promotion?: PieceSymbol): MoveEvent {
    const move = this.chess.move({ from, to, promotion });
    return this.describe(move);
  }

  /**
   * The legal move a coordinate move (`e2e4`, `e7e8q`) names in the current position, or null.
   * A promotion must name its piece; a non-promotion must not.
   */
  legalUci(uci: string): Move | null {
    const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci.trim().toLowerCase());
    if (!m) return null;
    const [, from, to, promotion] = m;
    return this.chess.moves({ square: from as Square, verbose: true }).find((x) => x.to === to && (x.promotion ?? undefined) === (promotion ?? undefined)) ?? null;
  }

  /** Take back the last move; returns it, or null at the start of the game. */
  undo(): Move | null {
    return this.chess.undo();
  }

  private describe(m: Move): MoveEvent {
    const c = this.chess;
    const event: MoveEvent = {
      san: m.san,
      color: m.color,
      piece: m.piece,
      from: m.from,
      to: m.to,
      enPassant: m.isEnPassant(),
      check: c.isCheck(),
      checkmate: c.isCheckmate(),
      draw: this.drawReason(),
      fenBefore: m.before,
      fenAfter: m.after,
    };
    if (m.captured) {
      event.captured = m.captured;
      // En passant removes the pawn beside the mover, not the one on the destination square.
      event.capturedSquare = m.isEnPassant() ? ((m.to[0] + m.from[1]) as Square) : m.to;
    }
    if (m.promotion) event.promotion = m.promotion;
    if (m.isKingsideCastle() || m.isQueensideCastle()) {
      const rank = m.from[1];
      const king = m.isKingsideCastle();
      event.castle = { rookFrom: ((king ? 'h' : 'a') + rank) as Square, rookTo: ((king ? 'f' : 'd') + rank) as Square, side: king ? 'k' : 'q' };
    }
    return event;
  }
}
