// src/core/tetris.ts — 테트리스 코어 (순수 로직)
// 규약(§3): DOM·타이머·난수원 의존 0. 시간은 tick(state, dtMs)로 주입받고 난수는 상태 안의 seed로 전진한다.
// 상태 변환 함수는 새 객체를 반환하며 입력 상태를 변형하지 않는다(§14.1).
// 동작이 불가능하면 값이 같은 상태를 반환한다 — throw·null 반환 없음(§14.2).
// 절 번호는 prompt-tetris/_workspace/01_spec.md를 가리킨다.
//
// [무동작 호출의 events — §14.5 판정 완료(2026-09-14). 재판정 불필요]
//   스펙 내부 충돌(§14.2 "그대로 반환" vs §14.1·§13.1·QA 25 "비운다")을 오케스트레이터가 판정했다.
//   판정: **무동작 호출도 events를 []로 비운다.** 동일 참조 반환은 폐기.
//   이유 — 구체 조항(events를 직접 지목)이 일반 조항을 이기고, 이 선택만이 §14.4 루프의
//   실제 버그(일시정지·게임오버 중 tick이 직전 lock/gameOver events를 초당 60회 재방출 →
//   셸이 같은 소리를 반복)를 막으며, 고치는 자리가 코어 한 곳뿐이다.
//   셸 계약: 같은 이벤트가 두 번 오지 않는 것은 코어 책임이다. 셸은 소비 후 재검사하지 않아도 된다.
//   QA 16·24의 "불변"·"상태 동일"은 events를 뺀 나머지 필드의 **값** 동일로 판정한다(참조 비교 금지).
//   구현은 아래 idle()로 한 곳에 모았다.

import type {
  ActivePiece,
  GameEvent,
  GameState,
  ItemSlot,
  ItemType,
  PieceType,
  Rotation,
} from './types.ts';

/* ────────────────────────── 상수 (§14.3) ────────────────────────── */

export const COLS = 10;
export const VISIBLE_ROWS = 20;
export const BUFFER_ROWS = 20;
export const ROWS = 40; // VISIBLE_ROWS + BUFFER_ROWS (§2.2)
// 판정용 상수. 스폰 직후 1칸 하강을 시도하므로 정상 상황에서 관측되는 y는 19다 (§2.3).
export const SPAWN_Y = 18;
export const PIECE_TYPES = ['I', 'J', 'L', 'O', 'S', 'Z', 'T'] as const;

// §4.2 형태표. [rotation][y][x], y는 아래로 증가. 회전은 행렬 연산이 아니라 이 표 인덱싱으로 얻는다.
export const SHAPES: Record<PieceType, number[][][]> = {
  I: [
    [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]], // 0
    [[0,0,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0]], // R
    [[0,0,0,0],[0,0,0,0],[1,1,1,1],[0,0,0,0]], // 2
    [[0,1,0,0],[0,1,0,0],[0,1,0,0],[0,1,0,0]], // L
  ],
  J: [
    [[1,0,0],[1,1,1],[0,0,0]],
    [[0,1,1],[0,1,0],[0,1,0]],
    [[0,0,0],[1,1,1],[0,0,1]],
    [[0,1,0],[0,1,0],[1,1,0]],
  ],
  L: [
    [[0,0,1],[1,1,1],[0,0,0]],
    [[0,1,0],[0,1,0],[0,1,1]],
    [[0,0,0],[1,1,1],[1,0,0]],
    [[1,1,0],[0,1,0],[0,1,0]],
  ],
  O: [
    [[1,1],[1,1]], [[1,1],[1,1]], [[1,1],[1,1]], [[1,1],[1,1]],
  ],
  S: [
    [[0,1,1],[1,1,0],[0,0,0]],
    [[0,1,0],[0,1,1],[0,0,1]],
    [[0,0,0],[0,1,1],[1,1,0]],
    [[1,0,0],[1,1,0],[0,1,0]],
  ],
  Z: [
    [[1,1,0],[0,1,1],[0,0,0]],
    [[0,0,1],[0,1,1],[0,1,0]],
    [[0,0,0],[1,1,0],[0,1,1]],
    [[0,1,0],[1,1,0],[1,0,0]],
  ],
  T: [
    [[0,1,0],[1,1,1],[0,0,0]],
    [[0,1,0],[0,1,1],[0,1,0]],
    [[0,0,0],[1,1,1],[0,1,0]],
    [[0,1,0],[1,1,0],[0,1,0]],
  ],
};

// §5.2 / §5.3 — 이미 이 좌표계(y 아래로 +)로 변환된 값이다. 구현에서 부호를 다시 뒤집지 마라.
// 검산식은 §5.5: KICKS_*[전이][i] === [원문dx, -원문dy] (80쌍 전수).
export const KICKS_JLSTZ: Record<string, [number, number][]> = {
  '0>R': [[0,0], [-1,0], [-1,-1], [0,+2], [-1,+2]],
  'R>0': [[0,0], [+1,0], [+1,+1], [0,-2], [+1,-2]],
  'R>2': [[0,0], [+1,0], [+1,+1], [0,-2], [+1,-2]],
  '2>R': [[0,0], [-1,0], [-1,-1], [0,+2], [-1,+2]],
  '2>L': [[0,0], [+1,0], [+1,-1], [0,+2], [+1,+2]],
  'L>2': [[0,0], [-1,0], [-1,+1], [0,-2], [-1,-2]],
  'L>0': [[0,0], [-1,0], [-1,+1], [0,-2], [-1,-2]],
  '0>L': [[0,0], [+1,0], [+1,-1], [0,+2], [+1,+2]],
};

export const KICKS_I: Record<string, [number, number][]> = {
  '0>R': [[0,0], [-2,0], [+1,0], [-2,+1], [+1,-2]],
  'R>0': [[0,0], [+2,0], [-1,0], [+2,-1], [-1,+2]],
  'R>2': [[0,0], [-1,0], [+2,0], [-1,-2], [+2,+1]],
  '2>R': [[0,0], [+1,0], [-2,0], [+1,+2], [-2,-1]],
  '2>L': [[0,0], [+2,0], [-1,0], [+2,-1], [-1,+2]],
  'L>2': [[0,0], [-2,0], [+1,0], [-2,+1], [+1,-2]],
  'L>0': [[0,0], [+1,0], [-2,0], [+1,+2], [-2,-1]],
  '0>L': [[0,0], [-1,0], [+2,0], [-1,-2], [+2,+1]],
};

// §7.1 중력 = Math.round(1000 × 0.93^(n-1)). 런타임 계산 금지(반올림이 갈린다).
// 인덱스 0은 쓰지 않는다. 유효 인덱스 1..15.
export const GRAVITY_MS: (number | null)[] = [
  null, 1000, 930, 865, 804, 748, 696, 647, 602, 560, 520, 484, 450, 419, 389, 362,
];
export const GRAVITY_FLOOR_MS = 362; // 레벨 16 이상 고정값 (S1이 못 박음)
export const GRAVITY_CAP_LEVEL = 16; // 이 레벨부터 GRAVITY_FLOOR_MS

export const LINE_SCORE = [0, 50, 150, 300, 500]; // §8 인덱스 = 동시 삭제 줄 수
export const LOCK_SCORE = 10;
export const POINTS_PER_LEVEL = 100; // level = floor(score / 100) + 1 (§9.1)

export const ITEM_CYCLE = ['BAR', 'SQUARE', 'CLEAN', null, 'BOMB'] as const; // §10.1
export const ITEM_SLOTS = 3;
export const ITEM_FIT_DY = [0, -1, -2, -3];   // §10.4 탐색 순서 (바깥) (관례값)
export const ITEM_FIT_DX = [0, -1, 1, -2, 2]; // §10.4 탐색 순서 (안쪽) (관례값)

export const FX_LEVELUP_MS = 900; // §11 총 지속. 셸은 이 상수를 import해서 쓴다(900을 두 곳에 적지 않는다)

export const SOFT_DROP_FACTOR = 20; // (관례값)
export const LOCK_DELAY_MS = 500;
export const LOCK_RESET_LIMIT = 15;
export const PREVIEW_COUNT = 3;     // (관례값)
export const DAS_MS = 167;          // (관례값)
export const ARR_MS = 33;           // (관례값)
export const STEP_MS = 1000 / 60;   // (관례값)
export const MAX_FRAME_MS = 100;    // (관례값)

const ROT_NAMES = ['0', 'R', '2', 'L']; // §4.1

/* ────────────────────────── 조회 (§14.2) ────────────────────────── */

export function boxSize(type: PieceType): number {
  return SHAPES[type][0].length; // I=4, O=2, 나머지 3
}

// [dx, dy] 목록. 모듈 로드 시 한 번 만들어 캐시한다(순수 데이터).
const CELLS: Record<PieceType, [number, number][][]> = {} as Record<PieceType, [number, number][][]>;
for (const type of PIECE_TYPES) {
  CELLS[type] = SHAPES[type].map((grid) => {
    const out: [number, number][] = [];
    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y].length; x++) if (grid[y][x]) out.push([x, y]);
    }
    return out;
  });
}

// 캐시를 그대로 넘기면 호출자가 변형할 수 있으므로 복사해서 준다.
export function pieceCells(type: PieceType, rotation: Rotation): [number, number][] {
  return CELLS[type][rotation].map((c) => [c[0], c[1]] as [number, number]);
}

export function gravityMsFor(level: number): number {
  if (level >= GRAVITY_CAP_LEVEL) return GRAVITY_FLOOR_MS;
  return GRAVITY_MS[level] as number; // 레벨 1..15는 항상 숫자
}

export function itemForLevel(level: number): ItemType | null {
  return ITEM_CYCLE[(level - 1) % ITEM_CYCLE.length] ?? null;
}

export function ghostY(state: GameState): number | null {
  const p = state.active;
  if (!p) return null;
  let y = p.y;
  while (!collides(state.board, p.type, p.rotation, p.x, y + 1)) y++;
  return y;
}

/* ────────────────────────── RNG · 가방 (§6.1) ────────────────────────── */

// xorshift32 (관례값) — 어느 출처도 알고리즘을 강제하지 않는다. seed 0은 금지(1로 치환).
export function rngNext(seed: number): { seed: number; value: number } {
  let s = (seed >>> 0) || 1;
  s ^= s << 13; s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5;  s >>>= 0;
  return { seed: s, value: s / 0x100000000 }; // value ∈ [0, 1)
}

export function refillBag(seed: number): { bag: PieceType[]; seed: number } {
  const bag: PieceType[] = PIECE_TYPES.slice();
  let s = seed;
  for (let i = bag.length - 1; i > 0; i--) {
    const r = rngNext(s);
    s = r.seed;
    const j = Math.floor(r.value * (i + 1));
    const tmp = bag[i]; bag[i] = bag[j]; bag[j] = tmp;
  }
  return { bag, seed: s };
}

/* ────────────────────────── 내부 헬퍼 ────────────────────────── */

// §14.5 무동작 반환. events만 비우고 나머지 필드는 입력과 같다.
// 이미 비어 있으면 새 객체를 만들 이유가 없다(값이 같으므로 계약을 만족한다).
function idle(state: GameState): GameState {
  return state.events.length === 0 ? state : { ...state, events: [] };
}

function emptyRow(): (PieceType | null)[] {
  return new Array<PieceType | null>(COLS).fill(null);
}

function emptyBoard(): (PieceType | null)[][] {
  return Array.from({ length: ROWS }, emptyRow);
}

// y < 0 은 벽으로 취급한다(§2.1: 음수 좌표는 발생하지 않는다).
function collides(board: (PieceType | null)[][], type: PieceType, rotation: Rotation, x: number, y: number): boolean {
  for (const [dx, dy] of CELLS[type][rotation]) {
    const bx = x + dx, by = y + dy;
    if (bx < 0 || bx >= COLS || by < 0 || by >= ROWS) return true;
    if (board[by][bx]) return true;
  }
  return false;
}

function grounded(board: (PieceType | null)[][], p: ActivePiece): boolean {
  return collides(board, p.type, p.rotation, p.x, p.y + 1);
}

function spawnX(type: PieceType): number {
  return Math.floor((COLS - boxSize(type)) / 2); // §2.3 (I=3, O=4, 나머지 3)
}

// 큐 길이를 PREVIEW_COUNT + 1 이상으로 유지한다(§6.2).
function ensureQueue(queue: PieceType[], bag: PieceType[], seed: number) {
  const q = queue.slice();
  let b = bag.slice();
  let s = seed;
  while (q.length < PREVIEW_COUNT + 1) {
    if (b.length === 0) {
      const r = refillBag(s);
      b = r.bag;
      s = r.seed;
    }
    q.push(b.shift() as PieceType);
  }
  return { queue: q, bag: b, seed: s };
}

// §2.3 스폰 절차: 배치 → Block Out 판정 → 1칸 하강 1회 시도.
// 호출 시점의 state.events(그 호출이 지금까지 만든 것)에 이어붙인다.
function placePiece(state: GameState, type: PieceType): GameState {
  const x = spawnX(type);
  if (collides(state.board, type, 0, x, SPAWN_Y)) {
    return {
      ...state,
      active: null,
      status: 'over',
      events: [...state.events, { type: 'gameOver', reason: 'blockout', score: state.score }],
    };
  }
  const y = collides(state.board, type, 0, x, SPAWN_Y + 1) ? SPAWN_Y : SPAWN_Y + 1;
  return {
    ...state,
    active: { type, rotation: 0, x, y },
    gravityAcc: 0,
    lockTimer: null,
    lockResets: 0,
    lowestY: y, // §7.4 규칙 6
  };
}

function spawnNext(state: GameState): GameState {
  const type = state.queue[0];
  const filled = ensureQueue(state.queue.slice(1), state.bag, state.seed);
  return placePiece({ ...state, ...filled }, type);
}

// §7.4 규칙 5 — 최저행 갱신 시 리셋 카운터 초기화.
function updateLowest(s: GameState): GameState {
  const p = s.active as ActivePiece;
  if (p.y <= s.lowestY) return s;
  return { ...s, lowestY: p.y, lockResets: 0 };
}

// move/rotate 성공 후 처리. 적용 순서는 규칙 5 → 규칙 4다(§7.4).
// 역순이면 아래로 미는 킥이 리셋 1회를 공짜로 줘서 상한 15를 우회한다.
function afterPlayerMove(s: GameState): GameState {
  const next = updateLowest(s);
  if (!grounded(next.board, next.active as ActivePiece)) return next;
  if (next.lockResets >= LOCK_RESET_LIMIT) return next; // 상한: 타이머를 건드리지 않는다
  return { ...next, lockTimer: 0, lockResets: next.lockResets + 1 };
}

function clearLines(board: (PieceType | null)[][]) {
  const rows: number[] = [];
  for (let y = 0; y < ROWS; y++) if (board[y].every((c) => c !== null)) rows.push(y);
  if (rows.length === 0) return { board, rows };
  const kept = board.filter((_, y) => !rows.includes(y));
  const fresh = Array.from({ length: rows.length }, emptyRow);
  return { board: fresh.concat(kept), rows };
}

// §10.2 지급. 레벨 from+1 .. to 각각에 대해 1개씩 시도한다(§9.2 다단 상승).
function grantItems(items: ItemType[], from: number, to: number) {
  const next = items.slice();
  const events: GameEvent[] = [];
  for (let lv = from + 1; lv <= to; lv++) {
    const item = itemForLevel(lv);
    if (item === null) continue;
    const discarded = next.length >= ITEM_SLOTS; // 3칸이 차 있으면 새 것을 버린다
    if (!discarded) next.push(item);
    events.push({ type: 'itemGain', item, discarded });
  }
  return { items: next, events };
}

// §7.5 고정 절차 — 순서가 곧 점수다.
function lockPiece(state: GameState): GameState {
  const p = state.active as ActivePiece;
  const board = state.board.map((row) => row.slice());
  const cells = CELLS[p.type][p.rotation].map(([dx, dy]) => [p.x + dx, p.y + dy] as [number, number]);
  for (const [x, y] of cells) board[y][x] = p.type; // 1. 셀 값은 조각 종류 문자

  // 2. Lock Out — 3~7단계를 전부 건너뛴다. +10도, 줄삭제도, 레벨 갱신도, 다음 스폰도 없다.
  if (cells.every(([, y]) => y < VISIBLE_ROWS)) {
    return {
      ...state,
      board,
      active: null,
      status: 'over',
      events: [{ type: 'gameOver', reason: 'lockout', score: state.score }],
    };
  }

  const events: GameEvent[] = [];
  let score = state.score + LOCK_SCORE; // 3
  events.push({ type: 'lock', piece: p.type, points: LOCK_SCORE });

  // 4. 줄삭제
  const { board: cleared, rows } = clearLines(board);
  let lines = state.lines;
  if (rows.length > 0) {
    const count = rows.length as 1 | 2 | 3 | 4;
    score += LINE_SCORE[count];
    lines += count;
    events.push({ type: 'lineClear', rows, count, points: LINE_SCORE[count] });
  }

  // 5. 레벨 재계산은 고정 절차당 정확히 1회. 3·4의 점수가 모두 반영된 뒤다.
  let level = state.level;
  let items = state.items;
  let fxLevelUpMs = state.fxLevelUpMs;
  const nextLevel = Math.floor(score / POINTS_PER_LEVEL) + 1;
  if (nextLevel > level) {
    events.push({ type: 'levelUp', from: level, level: nextLevel }); // 다단 상승이어도 이벤트 1개
    const granted = grantItems(items, level, nextLevel);
    items = granted.items;
    for (const e of granted.events) events.push(e);
    fxLevelUpMs = FX_LEVELUP_MS; // 레벨당 누적하지 않는다(§9.2)
    level = nextLevel;
  }

  const merged: GameState = {
    ...state,
    board: cleared,
    active: null,
    score,
    lines,
    level,
    items,
    fxLevelUpMs,
    holdLocked: false, // 6
    gravityAcc: 0,
    lockTimer: null,
    lockResets: 0,
    events,
  };
  return spawnNext(merged); // 7
}

/* ────────────────────────── 공개 API (§14.2) ────────────────────────── */

export function createGame(opts?: { seed?: number }): GameState {
  const seed0 = opts?.seed === undefined ? 1 : opts.seed >>> 0; // 기본 시드 1 (관례값)
  const filled = ensureQueue([], [], seed0);
  // 레벨 1 진입 = 게임 시작. 지급 규칙은 레벨업과 같은 경로를 쓴다(§10.2).
  const granted = grantItems([], 0, 1);
  const base: GameState = {
    board: emptyBoard(),
    active: null,
    queue: filled.queue,
    bag: filled.bag,
    hold: null,
    holdLocked: false,
    items: granted.items,
    rescueLevel: 0, // §10.8 레벨이 올라도 초기화하지 않는다(리셋 로직이 곧 버그 자리다)
    score: 0,
    lines: 0,
    level: 1,
    status: 'playing',
    gravityAcc: 0,
    lockTimer: null,
    lockResets: 0,
    lowestY: 0,
    softDropping: false,
    fxLevelUpMs: 0,
    events: granted.events,
    seed: filled.seed,
  };
  return spawnNext(base);
}

export function tick(state: GameState, dtMs: number): GameState {
  if (state.status !== 'playing' || !(dtMs > 0)) return idle(state);

  // §9.3 레벨업 연출 중에는 중력·락딜레이가 멈춘다.
  // 0이 되는 tick의 남은 dt는 버린다(중력으로 이월하지 않는다).
  if (state.fxLevelUpMs > 0) {
    return { ...state, fxLevelUpMs: Math.max(0, state.fxLevelUpMs - dtMs), events: [] };
  }
  if (!state.active) return idle(state);

  const g = gravityMsFor(state.level);
  // §7.2 소프트드롭: 중력 20배. 하한 1ms(0 나눗셈·무한 루프 방지).
  const interval = state.softDropping ? Math.max(1, Math.round(g / SOFT_DROP_FACTOR)) : g;

  let s: GameState = { ...state, gravityAcc: state.gravityAcc + dtMs, events: [] };
  while (s.gravityAcc >= interval) {
    const p = s.active as ActivePiece;
    if (collides(s.board, p.type, p.rotation, p.x, p.y + 1)) {
      s = { ...s, gravityAcc: 0 }; // 막히면 누적을 비우고 중단 (§7.1)
      break;
    }
    s = updateLowest({ ...s, gravityAcc: s.gravityAcc - interval, active: { ...p, y: p.y + 1 } });
  }

  // §7.4 락딜레이. 소프트드롭이어도 즉시 고정하지 않는다(비잠금).
  if (!grounded(s.board, s.active as ActivePiece)) return { ...s, lockTimer: null };
  const lockTimer = (s.lockTimer === null ? 0 : s.lockTimer) + dtMs;
  if (lockTimer >= LOCK_DELAY_MS) return lockPiece({ ...s, lockTimer });
  return { ...s, lockTimer };
}

export function move(state: GameState, dx: -1 | 1): GameState {
  if (state.status !== 'playing' || !state.active) return idle(state);
  const p = state.active;
  if (collides(state.board, p.type, p.rotation, p.x + dx, p.y)) return idle(state);
  return afterPlayerMove({ ...state, active: { ...p, x: p.x + dx }, events: [{ type: 'move', dx }] });
}

export function rotate(state: GameState, dir: -1 | 1): GameState {
  if (state.status !== 'playing' || !state.active) return idle(state);
  const p = state.active;
  const to = ((p.rotation + (dir > 0 ? 1 : 3)) & 3) as Rotation;
  const events: GameEvent[] = [{ type: 'rotate', dir }];

  // O는 4상태가 동일하고 킥도 하지 않는다. 회전은 항상 성공한다(§4.2).
  if (p.type === 'O') return afterPlayerMove({ ...state, active: { ...p, rotation: to }, events });

  const table = p.type === 'I' ? KICKS_I : KICKS_JLSTZ;
  const offsets = table[ROT_NAMES[p.rotation] + '>' + ROT_NAMES[to]];
  for (const [dx, dy] of offsets) {
    if (!collides(state.board, p.type, to, p.x + dx, p.y + dy)) {
      return afterPlayerMove({ ...state, active: { ...p, rotation: to, x: p.x + dx, y: p.y + dy }, events });
    }
  }
  return idle(state); // 5개 전부 실패 → 회전은 일어나지 않는다 (§5.1)
}

export function softDrop(state: GameState, on: boolean): GameState {
  if (state.status !== 'playing') return idle(state);
  // 같은 값 재호출은 상태를 건드리지 않는다(§7.2). 이게 없으면 셸이 매 프레임
  // softDrop(s,true)를 재호출할 때 누적이 계속 0이 되어 소프트드롭이 영원히 발동하지 않는다.
  if (state.softDropping === on) return idle(state);
  return { ...state, softDropping: on, gravityAcc: 0, events: [] };
}

export function hardDrop(state: GameState): GameState {
  if (state.status !== 'playing' || !state.active) return idle(state);
  const p = state.active;
  let y = p.y;
  while (!collides(state.board, p.type, p.rotation, p.x, y + 1)) y++;
  // §7.3 락딜레이 없이 그 자리에서 고정. 이동 거리 점수는 없다.
  return lockPiece({ ...state, active: { ...p, y }, events: [] });
}

export function hold(state: GameState): GameState {
  if (state.status !== 'playing' || !state.active || state.holdLocked) return idle(state);
  const current = state.active.type;
  const base: GameState = {
    ...state,
    hold: current,
    holdLocked: true, // 고정될 때까지 재홀드 불가 (§6.3)
    events: [{ type: 'hold', piece: current }],
  };
  return state.hold === null ? spawnNext(base) : placePiece(base, state.hold);
}

export function useItem(state: GameState, slot: ItemSlot): GameState {
  if (state.status !== 'playing') return idle(state); // 일시정지·게임오버 중 사용 불가 (연출 중은 사용 가능)
  if (!state.active || slot >= state.items.length) return idle(state);
  const item = state.items[slot];
  const rest = state.items.filter((_, i) => i !== slot); // 뒤 슬롯이 앞으로 당겨진다

  if (item === 'BAR' || item === 'SQUARE') {
    // §10.4 조각 교체. BAR = 세로 I(회전 R), SQUARE = O(회전 0).
    const type: PieceType = item === 'BAR' ? 'I' : 'O';
    const rotation: Rotation = item === 'BAR' ? 1 : 0;
    for (const dy of ITEM_FIT_DY) {
      for (const dx of ITEM_FIT_DX) {
        const x = state.active.x + dx;
        const y = state.active.y + dy;
        if (collides(state.board, type, rotation, x, y)) continue;
        return {
          ...state,
          active: { type, rotation, x, y },
          items: rest,
          lockTimer: null,
          lockResets: 0,
          lowestY: y,
          events: [{ type: 'itemUse', item, slot }],
        };
      }
    }
    // 20후보 전부 충돌 = 자리 부족. 아이템을 소모하지 않고 조각도 그대로 둔다.
    return { ...state, events: [{ type: 'itemFail', item, slot, reason: 'nofit' }] };
  }

  // §10.5 CLEAN = 맨 아래 한 줄(y=39) 삭제 / §10.6 BOMB = 보드 전체 삭제.
  // 둘 다 점수 0이고 lines도 올리지 않는다 (관례값: S1은 점수 0만 규정).
  const board = item === 'BOMB'
    ? emptyBoard()
    : [emptyRow(), ...state.board.slice(0, ROWS - 1)];

  // §10.7-1 밀린 블록이 현재 조각과 겹치면 위로 1칸씩 최대 4회 밀어 올린다 (관례값).
  let active = state.active;
  for (let i = 0; i < 4 && active.y > 0; i++) {
    if (!collides(board, active.type, active.rotation, active.x, active.y)) break;
    active = { ...active, y: active.y - 1 };
  }

  return {
    ...state,
    board,
    active,
    items: rest,
    lockTimer: null,   // §10.7-2 (lowestY는 유지)
    lockResets: 0,
    gravityAcc: 0,     // §10.7-3
    events: [{ type: 'itemUse', item, slot }],
    // §10.7-4 줄삭제 판정을 다시 하지 않는다 — 아이템으로 점수를 만드는 경로를 아예 만들지 않는다.
  };
}

// §10.8 아이템 구제 호출. 조건은 하나다 — 0칸이고 이번 레벨에 아직 안 불렀으면 긴막대 1개.
// 부를 수 있는 아이템은 BAR 고정이다 (관례값). 폭탄이 여기서 나오면
// 폭탄 → 레벨업 → 폭탄 연쇄로 난이도 곡선이 무너진다(prompt.md).
// 레벨업 연출 중에는 쓸 수 있다(§10.3과 동일). 이벤트는 기존 itemGain을 재사용한다.
export function summonItem(state: GameState): GameState {
  if (state.status !== 'playing') return idle(state);
  // rescueLevel !== level 비교만으로 "이번 레벨에 썼는가"가 판정된다. 별도 리셋은 두지 않는다.
  if (state.items.length !== 0 || state.rescueLevel === state.level) return idle(state);
  return {
    ...state,
    items: ['BAR'],
    rescueLevel: state.level,
    events: [{ type: 'itemGain', item: 'BAR', discarded: false }],
  };
}

export function togglePause(state: GameState): GameState {
  if (state.status === 'playing') return { ...state, status: 'paused', events: [] };
  if (state.status === 'paused') return { ...state, status: 'playing', events: [] };
  return idle(state); // 'over'면 그대로
}
