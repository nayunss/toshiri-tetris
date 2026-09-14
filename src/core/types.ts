// src/core/types.ts — 공개 타입 (스펙 §14.1 전문)
// 이 파일은 코어와 셸의 계약이다. 시그니처를 바꿔야 하면 혼자 바꾸지 말고 오케스트레이터에 보고한다.

export type PieceType = 'I' | 'J' | 'L' | 'O' | 'S' | 'Z' | 'T';
export type Rotation = 0 | 1 | 2 | 3; // 0, R, 2, L (§4.1)
export type Status = 'playing' | 'paused' | 'over';
export type ItemType = 'BAR' | 'SQUARE' | 'CLEAN' | 'BOMB';
export type ItemSlot = 0 | 1 | 2;

export interface ActivePiece {
  type: PieceType;
  rotation: Rotation;
  x: number; // 바운딩 박스 좌상단 열 (박스에 빈 칸이 있어 0..9를 벗어날 수 있다)
  y: number; // 바운딩 박스 좌상단 행 (y 아래로 +)
}

export type GameEvent =
  | { type: 'move'; dx: -1 | 1 }
  | { type: 'rotate'; dir: -1 | 1 }
  | { type: 'hold'; piece: PieceType }
  | { type: 'lock'; piece: PieceType; points: number } // points는 항상 10
  | { type: 'lineClear'; rows: number[]; count: 1 | 2 | 3 | 4; points: number }
  | { type: 'levelUp'; from: number; level: number }
  | { type: 'itemGain'; item: ItemType; discarded: boolean }
  | { type: 'itemUse'; item: ItemType; slot: ItemSlot }
  | { type: 'itemFail'; item: ItemType; slot: ItemSlot; reason: 'nofit' }
  | { type: 'gameOver'; reason: 'blockout' | 'lockout'; score: number };

export interface GameState {
  board: (PieceType | null)[][]; // [40][10], board[y][x]. 색이 아니라 조각 종류
  active: ActivePiece | null; // status === 'over'면 null
  queue: PieceType[]; // 길이 >= PREVIEW_COUNT + 1. [0]이 다음 조각
  bag: PieceType[]; // 현재 가방의 남은 조각(큐 보충용 내부 상태)
  hold: PieceType | null;
  holdLocked: boolean;

  items: ItemType[]; // 길이 0..3. [0]이 숫자키 1
  rescueLevel: number; // §10.8 구제 호출을 마지막으로 쓴 레벨. 0 = 한 번도 안 씀

  score: number; // 정수
  lines: number; // 정수. 표시 전용 통계(레벨·점수에 쓰이지 않는다)
  level: number; // 정수, 1부터. 상한 없음

  status: Status;

  gravityAcc: number; // ms
  lockTimer: number | null; // ms, null = 접지 안 함
  lockResets: number; // 0..15
  lowestY: number;
  softDropping: boolean;

  fxLevelUpMs: number; // ms, 900 → 0. > 0이면 중력·락딜레이 정지

  events: GameEvent[]; // 직전 호출이 만든 것만. 호출마다 새로 채워진다
  seed: number; // uint32, RNG 상태
}
