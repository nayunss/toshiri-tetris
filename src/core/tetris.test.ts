// src/core/tetris.test.ts — node --test 로 실행 (npm test). 외부 테스트 프레임워크 없음.
// 스펙 §16 QA 대조 체크리스트를 옮긴 것이다. 절 번호는 _workspace/01_spec.md를 가리킨다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COLS, ROWS, VISIBLE_ROWS, BUFFER_ROWS, SPAWN_Y, PIECE_TYPES, SHAPES,
  KICKS_I, KICKS_JLSTZ, GRAVITY_MS, GRAVITY_FLOOR_MS, GRAVITY_CAP_LEVEL,
  LINE_SCORE, LOCK_SCORE, POINTS_PER_LEVEL, ITEM_CYCLE, ITEM_SLOTS,
  ITEM_FIT_DX, ITEM_FIT_DY, FX_LEVELUP_MS, SOFT_DROP_FACTOR,
  LOCK_DELAY_MS, LOCK_RESET_LIMIT, PREVIEW_COUNT, DAS_MS, ARR_MS, STEP_MS, MAX_FRAME_MS,
  createGame, tick, move, rotate, softDrop, hardDrop, hold, useItem, togglePause, summonItem,
  ghostY, pieceCells, boxSize, itemForLevel, gravityMsFor, rngNext, refillBag,
} from './tetris.ts';
import type { ActivePiece, GameState, ItemType, PieceType } from './types.ts';

/* ────────────────────────── 테스트 헬퍼 ────────────────────────── */

function emptyBoard(): (PieceType | null)[][] {
  return Array.from({ length: ROWS }, () => new Array<PieceType | null>(COLS).fill(null));
}

function fillRow(b: (PieceType | null)[][], y: number, exceptX = -1): void {
  for (let x = 0; x < COLS; x++) if (x !== exceptX) b[y][x] = 'I';
}

function fullBoard(): (PieceType | null)[][] {
  const b = emptyBoard();
  for (let y = 0; y < ROWS; y++) fillRow(b, y);
  return b;
}

// createGame 기반 상태에 덮어쓰기. 상태는 순수 데이터라 이렇게 만들어도 안전하다.
function game(over: Partial<GameState> = {}): GameState {
  return { ...createGame(), board: emptyBoard(), ...over };
}

// §14.5 무동작 판정. "불변"은 events를 뺀 나머지 필드의 값 동일이고,
// 참조 동일성(===)으로 판정하지 않는다.
function assertIdle(after: GameState, before: GameState, msg: string): void {
  const { events: _a, ...a } = after;
  const { events: _b, ...b } = before;
  assert.deepEqual(a, b, `${msg}: events 외 필드 값 동일`);
  assert.deepEqual(after.events, [], `${msg}: events는 []`);
}

function act(s: GameState): ActivePiece {
  if (!s.active) throw new Error('active가 null이다');
  return s.active;
}

function piece(type: PieceType, rotation: 0 | 1 | 2 | 3, x: number, y: number): ActivePiece {
  return { type, rotation, x, y };
}

/* ────────────────────────── 1. 킥 테이블 80쌍 역변환 (§5.5) ────────────────────────── */

// §5.4 변환 전 원본(tetris.wiki 규약: y 위쪽 +). 3·4·5번은 §5.4 표 그대로,
// 1·2번은 §5.4 각주("1·2번은 dy=0이라 변환 전후가 같다")에 따라 dy=0으로 옮겼다.
const ORIG_JLSTZ: Record<string, [number, number][]> = {
  '0>R': [[0,0], [-1,0], [-1,+1], [0,-2], [-1,-2]],
  'R>0': [[0,0], [+1,0], [+1,-1], [0,+2], [+1,+2]],
  'R>2': [[0,0], [+1,0], [+1,-1], [0,+2], [+1,+2]],
  '2>R': [[0,0], [-1,0], [-1,+1], [0,-2], [-1,-2]],
  '2>L': [[0,0], [+1,0], [+1,+1], [0,-2], [+1,-2]],
  'L>2': [[0,0], [-1,0], [-1,-1], [0,+2], [-1,+2]],
  'L>0': [[0,0], [-1,0], [-1,-1], [0,+2], [-1,+2]],
  '0>L': [[0,0], [+1,0], [+1,+1], [0,-2], [+1,-2]],
};

const ORIG_I: Record<string, [number, number][]> = {
  '0>R': [[0,0], [-2,0], [+1,0], [-2,-1], [+1,+2]],
  'R>0': [[0,0], [+2,0], [-1,0], [+2,+1], [-1,-2]],
  'R>2': [[0,0], [-1,0], [+2,0], [-1,+2], [+2,-1]],
  '2>R': [[0,0], [+1,0], [-2,0], [+1,-2], [-2,+1]],
  '2>L': [[0,0], [+2,0], [-1,0], [+2,+1], [-1,-2]],
  'L>2': [[0,0], [-2,0], [+1,0], [-2,-1], [+1,+2]],
  'L>0': [[0,0], [+1,0], [-2,0], [+1,-2], [-2,+1]],
  '0>L': [[0,0], [-1,0], [+2,0], [-1,+2], [+2,-1]],
};

test('§5.5 킥 테이블 80쌍 — KICKS[전이][i] === [원문dx, -원문dy]', () => {
  const pairs: string[] = [];
  for (const [name, orig, impl] of [
    ['JLSTZ', ORIG_JLSTZ, KICKS_JLSTZ] as const,
    ['I', ORIG_I, KICKS_I] as const,
  ]) {
    const keys = Object.keys(orig);
    assert.equal(keys.length, 8, `${name} 전이 8개`);
    assert.deepEqual(Object.keys(impl).sort(), keys.slice().sort(), `${name} 전이 키 집합`);
    for (const k of keys) {
      assert.equal(impl[k].length, 5, `${name} ${k} 오프셋 5개`);
      for (let i = 0; i < 5; i++) {
        const ody = orig[k][i][1];
        assert.deepEqual(
          impl[k][i],
          [orig[k][i][0], ody === 0 ? 0 : -ody], // deepStrictEqual은 0과 -0을 구분한다
          `${name} ${k} 오프셋 ${i + 1}`,
        );
        pairs.push(`${name}${k}${i}`);
      }
    }
  }
  assert.equal(pairs.length, 80, '16전이 × 5오프셋 = 80쌍 전수');
});

test('§5.5 검산 예시 — KICKS_I[0>R][4] === [+1,-2] (부호 재역전 방지)', () => {
  assert.deepEqual(KICKS_I['0>R'][4], [1, -2]);
  assert.deepEqual(KICKS_JLSTZ['0>R'][3], [0, 2]);
});

/* ────────────────────────── 2. 중력표 (§7.1) ────────────────────────── */

test('§7.1 GRAVITY_MS[1..15] = Math.round(1000 × 0.93^(n-1))', () => {
  const expected = [1000, 930, 865, 804, 748, 696, 647, 602, 560, 520, 484, 450, 419, 389, 362];
  assert.equal(GRAVITY_MS[0], null, '인덱스 0은 쓰지 않는다');
  for (let n = 1; n <= 15; n++) {
    assert.equal(GRAVITY_MS[n], expected[n - 1], `GRAVITY_MS[${n}]`);
    assert.equal(GRAVITY_MS[n], Math.round(1000 * Math.pow(0.93, n - 1)), `레벨 ${n} 식 대조`);
    assert.equal(gravityMsFor(n), expected[n - 1], `gravityMsFor(${n})`);
  }
});

test('§7.1 반올림은 Math.round — floor와 갈리는 7개 레벨', () => {
  // 레벨 3·6·7·8·9·11·13은 floor면 1ms 낮다. 이 7개가 round/floor 판정점이다.
  const roundVsFloor: [number, number, number][] = [
    [3, 865, 864], [6, 696, 695], [7, 647, 646], [8, 602, 601],
    [9, 560, 559], [11, 484, 483], [13, 419, 418],
  ];
  for (const [n, round, floor] of roundVsFloor) {
    assert.equal(GRAVITY_MS[n], round, `레벨 ${n}은 round 값`);
    assert.notEqual(GRAVITY_MS[n], floor, `레벨 ${n}이 floor 값이면 FAIL`);
    assert.equal(Math.floor(1000 * Math.pow(0.93, n - 1)), floor, '대조군: floor 계산값');
  }
});

test('§7.1 레벨 16 이상은 362ms 고정 (식값 337이 아니다)', () => {
  assert.equal(GRAVITY_FLOOR_MS, 362);
  assert.equal(GRAVITY_CAP_LEVEL, 16);
  for (const n of [16, 17, 100]) assert.equal(gravityMsFor(n), 362, `레벨 ${n}`);
  assert.notEqual(gravityMsFor(16), Math.round(1000 * Math.pow(0.93, 15)));
  // 검산: 레벨 15의 식값 반올림도 362 — 표와 산술적으로 일치한다.
  assert.equal(gravityMsFor(15), 362);
});

/* ────────────────────────── 3. 형태·스폰 (§4, §2.3) ────────────────────────── */

test('§4.2 SHAPES — 7종 × 4회전 모두 셀 4개', () => {
  for (const t of PIECE_TYPES) {
    assert.equal(SHAPES[t].length, 4, `${t} 회전 4상태`);
    for (let r = 0; r < 4; r++) {
      const cells = pieceCells(t, r as 0 | 1 | 2 | 3);
      assert.equal(cells.length, 4, `${t} 회전 ${r} 셀 수`);
    }
  }
});

test('§4.2 형태 표본 대조 + boxSize', () => {
  assert.deepEqual(pieceCells('T', 0), [[1, 0], [0, 1], [1, 1], [2, 1]]);
  assert.deepEqual(pieceCells('I', 1), [[2, 0], [2, 1], [2, 2], [2, 3]]); // 세로 막대는 3번째 열
  assert.deepEqual(pieceCells('S', 0), [[1, 0], [2, 0], [0, 1], [1, 1]]);
  assert.deepEqual(pieceCells('O', 2), [[0, 0], [1, 0], [0, 1], [1, 1]]);
  assert.equal(boxSize('I'), 4);
  assert.equal(boxSize('O'), 2);
  for (const t of ['J', 'L', 'S', 'Z', 'T'] as const) assert.equal(boxSize(t), 3);
});

test('§4.2 pieceCells는 캐시를 노출하지 않는다(호출자가 변형해도 다음 호출이 멀쩡)', () => {
  const a = pieceCells('T', 0);
  a[0][0] = 99;
  assert.deepEqual(pieceCells('T', 0)[0], [1, 0]);
});

test('§2.3 스폰 — 7종 모두 SPAWN_X 규칙, 스폰 직후 y === 19', () => {
  for (const t of PIECE_TYPES) {
    const s = game({ hold: null, holdLocked: false, queue: [t, 'O', 'O', 'O'] });
    const h = hold(s); // hold===null 경로 = 큐 맨 앞을 스폰
    const p = act(h);
    assert.equal(p.type, t);
    assert.equal(p.rotation, 0);
    assert.equal(p.x, Math.floor((COLS - boxSize(t)) / 2), `${t} 스폰 x`);
    assert.equal(p.y, 19, `${t} 스폰 직후 y (SPAWN_Y=18에서 1칸 하강)`);
  }
  assert.equal(SPAWN_Y, 18);
});

test('§2.2 보드 상수', () => {
  assert.equal(COLS, 10);
  assert.equal(VISIBLE_ROWS, 20);
  assert.equal(BUFFER_ROWS, 20);
  assert.equal(ROWS, 40);
  const s = createGame();
  assert.equal(s.board.length, 40);
  assert.equal(s.board[0].length, 10);
});

/* ────────────────────────── 4. 회전과 킥 동작 (§5.1) ────────────────────────── */

test('§4.2 O는 킥 없이 항상 회전 성공 — 꽉 막힌 2×2 주머니에서도', () => {
  const b = fullBoard();
  for (const [x, y] of [[4, 14], [5, 14], [4, 15], [5, 15]]) b[y][x] = null;
  const s = game({ board: b, active: piece('O', 0, 4, 14) });
  const r = rotate(s, 1);
  assert.equal(act(r).rotation, 1);
  assert.equal(act(r).x, 4);
  assert.equal(act(r).y, 14);
});

test('§5.1 회전 4회(CW)면 제자리 — 열린 자리에서는 첫 오프셋 (0,0)이 채택된다', () => {
  for (const t of PIECE_TYPES) {
    let s = game({ active: piece(t, 0, 3, 10) });
    for (let i = 0; i < 4; i++) s = rotate(s, 1);
    assert.deepEqual(act(s), piece(t, 0, 3, 10), `${t} 4회 회전`);
  }
});

test('§5.1 오프셋 5개가 모두 실패하면 상태를 그대로 반환(회전 없음)', () => {
  const b = fullBoard();
  for (const [x, y] of [[4, 14], [5, 14], [4, 15], [5, 15]]) b[y][x] = null;
  const s = game({ board: b, active: piece('T', 0, 3, 14) }); // T가 들어갈 자리가 없다
  const blocked = game({ board: b, active: piece('I', 0, 3, 14) });
  assertIdle(rotate(blocked, 1), blocked, '킥 5개 전부 실패');
  assertIdle(rotate(blocked, -1), blocked, '킥 5개 전부 실패(CCW)');
  assert.ok(s.board[13][3] !== null); // 보드가 실제로 막혀 있는지 확인
});

/* ────────────────────────── 5. 점수 (§8) ────────────────────────── */

test('§8 조각 고정 +10, 하드드롭 거리 점수 0', () => {
  const s = game({ active: piece('O', 0, 4, 19) });
  const r = hardDrop(s);
  assert.equal(r.score, 10, '낙하 거리 19칸이어도 +10뿐');
  assert.equal(r.lines, 0);
  const lock = r.events.find((e) => e.type === 'lock');
  assert.deepEqual(lock, { type: 'lock', piece: 'O', points: 10 });
  assert.equal(LOCK_SCORE, 10);
});

test('§8 줄삭제 1·2·3·4 = 50·150·300·500, 레벨 배율 없음', () => {
  assert.deepEqual(LINE_SCORE, [0, 50, 150, 300, 500]);
  for (const n of [1, 2, 3, 4] as const) {
    const b = emptyBoard();
    for (let y = ROWS - n; y < ROWS; y++) fillRow(b, y, 9); // 9열만 비운다
    const s = game({ board: b, active: piece('I', 1, 7, 20), level: 5 }); // 세로 I가 9열로 떨어진다
    const r = hardDrop(s);
    assert.equal(r.score, 10 + LINE_SCORE[n], `${n}줄: 고정 10 + ${LINE_SCORE[n]} (레벨 5여도 배율 없음)`);
    assert.equal(r.lines, n);
    const ev = r.events.find((e) => e.type === 'lineClear');
    assert.ok(ev && ev.type === 'lineClear');
    assert.equal(ev.count, n);
    assert.equal(ev.points, LINE_SCORE[n]);
    assert.deepEqual(ev.rows, Array.from({ length: n }, (_, i) => ROWS - n + i));
  }
});

test('§8 소프트드롭은 0점 (칸당 점수 없음)', () => {
  const s = game({ active: piece('O', 0, 4, 19), softDropping: true, score: 0 });
  const r = tick(s, 200); // 간격 50ms → 4칸 (바닥 전에서 끊어 고정 효과를 섞지 않는다)
  assert.equal(act(r).y, 23, '실제로 내려갔는지');
  assert.equal(r.score, 0);
});

test('§8 콤보 필드 자체가 없다', () => {
  const s = createGame();
  assert.equal('combo' in s, false);
});

/* ────────────────────────── 6. 레벨 (§9) ────────────────────────── */

test('§9.1 level = floor(score/100)+1 — 경계 99/100/101', () => {
  assert.equal(POINTS_PER_LEVEL, 100);
  const at = (before: number) => hardDrop(game({ active: piece('O', 0, 4, 19), score: before, level: Math.floor(before / 100) + 1 }));
  const a = at(89);
  assert.equal(a.score, 99);
  assert.equal(a.level, 1, 'score 99 → level 1');
  const b = at(90);
  assert.equal(b.score, 100);
  assert.equal(b.level, 2, 'score 100 → level 2');
  const c = at(91);
  assert.equal(c.score, 101);
  assert.equal(c.level, 2, 'score 101 → level 2');
  assert.equal(createGame().level, 1);
});

test('§9.2 4줄 삭제로 레벨 2→7 — levelUp 이벤트 1개, fx 900, 아이템은 지나간 레벨마다', () => {
  const b = emptyBoard();
  for (let y = 36; y < 40; y++) fillRow(b, y, 9);
  const s = game({ board: b, active: piece('I', 1, 7, 20), score: 150, level: 2, items: [] });
  const r = hardDrop(s);

  assert.equal(r.score, 660, '150 + 10 + 500');
  assert.equal(r.level, 7);
  const ups = r.events.filter((e) => e.type === 'levelUp');
  assert.equal(ups.length, 1, '연출은 1회');
  assert.deepEqual(ups[0], { type: 'levelUp', from: 2, level: 7 });
  assert.equal(r.fxLevelUpMs, 900, '레벨당 누적하지 않는다');
  assert.equal(FX_LEVELUP_MS, 900);

  // 레벨 3·4·5·6·7 중 4는 null → 지급 시도 4건, 슬롯 3칸이므로 네 번째는 버려진다.
  const gains = r.events.filter((e) => e.type === 'itemGain');
  assert.deepEqual(
    gains.map((e) => (e.type === 'itemGain' ? [e.item, e.discarded] : null)),
    [['CLEAN', false], ['BOMB', false], ['BAR', false], ['SQUARE', true]],
  );
  assert.deepEqual(r.items, ['CLEAN', 'BOMB', 'BAR']);
  assert.equal(r.items.length, ITEM_SLOTS);
});

/* ────────────────────────── 7. 아이템 (§10) ────────────────────────── */

test('§10.1 아이템 5주기 — 레벨 1..20 전수', () => {
  const expected: (ItemType | null)[] = [
    'BAR', 'SQUARE', 'CLEAN', null, 'BOMB',
    'BAR', 'SQUARE', 'CLEAN', null, 'BOMB',
    'BAR', 'SQUARE', 'CLEAN', null, 'BOMB',
    'BAR', 'SQUARE', 'CLEAN', null, 'BOMB',
  ];
  for (let lv = 1; lv <= 20; lv++) assert.equal(itemForLevel(lv), expected[lv - 1], `레벨 ${lv}`);
  for (const lv of [10, 15, 20]) assert.equal(itemForLevel(lv), 'BOMB', `레벨 ${lv} 폭탄 재지급`);
  assert.deepEqual(ITEM_CYCLE.slice(), ['BAR', 'SQUARE', 'CLEAN', null, 'BOMB']);
});

test('§10.2 시작 시 긴막대 1개 + itemGain 이벤트', () => {
  const s = createGame();
  assert.deepEqual(s.items, ['BAR']);
  assert.deepEqual(s.events, [{ type: 'itemGain', item: 'BAR', discarded: false }]);
});

test('§10.3 일시정지·게임오버 중에는 사용 불가(상태·이벤트 불변), 연출 중에는 사용 가능', () => {
  const b = emptyBoard();
  b[39][0] = 'J';
  const base = game({ board: b, items: ['BOMB'], active: piece('O', 0, 4, 19) });

  const paused = togglePause(base);
  assertIdle(useItem(paused, 0), paused, '일시정지 중 아이템');

  const over = { ...base, status: 'over' as const, active: null };
  assertIdle(useItem(over, 0), over, '게임오버 중 아이템');

  const fx = { ...base, fxLevelUpMs: 900 };
  const used = useItem(fx, 0);
  assert.equal(used.board[39][0], null, '연출 중에도 폭탄이 동작한다');
  assert.deepEqual(used.items, []);
});

test('§10.3 빈 슬롯은 무음 무동작', () => {
  const s = game({ items: ['BAR'] });
  assertIdle(useItem(s, 1), s, '빈 슬롯 1');
  assertIdle(useItem(s, 2), s, '빈 슬롯 2');
});

test('§10.3 슬롯은 앞으로 당겨진다', () => {
  const s = game({ items: ['BAR', 'BOMB', 'CLEAN'], active: piece('O', 0, 4, 10) });
  const r = useItem(s, 0); // BAR: 열린 자리라 성공
  assert.deepEqual(r.items, ['BOMB', 'CLEAN']);
  const ev = r.events[0];
  assert.deepEqual(ev, { type: 'itemUse', item: 'BAR', slot: 0 });
});

test('§10.4 BAR/SQUARE 교체 결과 — 세로 I(회전 R) / O(회전 0)', () => {
  const s = game({ items: ['BAR', 'SQUARE'], active: piece('T', 0, 4, 10), lockResets: 9, lockTimer: 120 });
  const bar = useItem(s, 0);
  assert.deepEqual(act(bar), piece('I', 1, 4, 10));
  assert.equal(bar.lockTimer, null);
  assert.equal(bar.lockResets, 0);
  assert.equal(bar.lowestY, 10);
  assert.equal(bar.score, s.score, '아이템은 점수를 바꾸지 않는다');
  assert.equal(bar.hold, s.hold);
  assert.equal(bar.holdLocked, s.holdLocked);
  assert.deepEqual(bar.queue, s.queue, '교체된 원래 조각은 큐로 돌아가지 않는다');

  const sq = useItem(s, 1);
  assert.deepEqual(act(sq), piece('O', 0, 4, 10));
});

test('§10.4 자리 부족이면 미소모 + itemFail(nofit) + active 불변', () => {
  const b = fullBoard();
  for (const [x, y] of [[4, 14], [5, 14], [4, 15], [5, 15]]) b[y][x] = null; // 2×2 주머니뿐
  const s = game({ board: b, items: ['BAR', 'SQUARE'], active: piece('O', 0, 4, 14) });

  const fail = useItem(s, 0);
  assert.deepEqual(fail.items, ['BAR', 'SQUARE'], '아이템을 소모하지 않는다');
  assert.deepEqual(fail.active, s.active, 'active 불변');
  assert.deepEqual(fail.events, [{ type: 'itemFail', item: 'BAR', slot: 0, reason: 'nofit' }]);

  const ok = useItem(s, 1); // 같은 자리에 O는 들어간다
  assert.deepEqual(ok.items, ['BAR']);
  assert.deepEqual(act(ok), piece('O', 0, 4, 14));
});

test('§10.4 탐색 순서 — dy=0 전부 실패하고 dy=-1에서 들어간다', () => {
  assert.deepEqual(ITEM_FIT_DY, [0, -1, -2, -3]);
  assert.deepEqual(ITEM_FIT_DX, [0, -1, 1, -2, 2]);
  const b = fullBoard();
  // 세로 I가 들어갈 유일한 자리: 6열의 12..15행. 조각은 (4,13)의 2×2 주머니에 있다.
  for (const y of [12, 13, 14, 15]) b[y][6] = null;
  for (const [x, y] of [[4, 13], [5, 13], [4, 14], [5, 14]]) b[y][x] = null;
  const s = game({ board: b, items: ['BAR'], active: piece('O', 0, 4, 13) });
  const r = useItem(s, 0);
  assert.deepEqual(act(r), piece('I', 1, 4, 12), 'y === 원래y - 1');
  assert.deepEqual(r.items, []);
});

test('§10.5 CLEAN — y=39 삭제, 전체 1칸 하강, 점수·lines 불변', () => {
  const b = emptyBoard();
  b[38][0] = 'J';
  b[39][5] = 'T';
  const s = game({ board: b, items: ['CLEAN'], active: piece('O', 0, 4, 10), score: 33, lines: 7, gravityAcc: 400, lockTimer: 200, lockResets: 4, lowestY: 10 });
  const r = useItem(s, 0);
  assert.equal(r.board[39][0], 'J', '38행이 39행으로 내려왔다');
  assert.equal(r.board[38][0], null);
  assert.equal(r.board.flat().filter((c) => c === 'T').length, 0, '원래 39행은 사라졌다');
  assert.equal(r.board[0].every((c) => c === null), true, '0행은 빈 행');
  assert.equal(r.score, 33);
  assert.equal(r.lines, 7);
  assert.equal(r.lockTimer, null);
  assert.equal(r.lockResets, 0);
  assert.equal(r.gravityAcc, 0);
  assert.equal(r.lowestY, 10, 'lowestY는 유지');
});

test('§10.5 y=39가 비어 있어도 성공 처리(아이템 소모)', () => {
  const s = game({ items: ['CLEAN'], active: piece('O', 0, 4, 10) });
  const r = useItem(s, 0);
  assert.deepEqual(r.items, []);
  assert.equal(r.events[0].type, 'itemUse');
});

test('§10.6 BOMB — 40행 전부 비우고 점수·lines 불변, active 유지', () => {
  const s = game({ board: fullBoard(), items: ['BOMB'], active: piece('O', 0, 4, 14), score: 250, lines: 11, level: 3 });
  const r = useItem(s, 0);
  assert.equal(r.board.flat().every((c) => c === null), true, '보드 전체가 빈다');
  assert.equal(r.board.length, 40);
  assert.equal(r.score, 250);
  assert.equal(r.lines, 11);
  assert.equal(r.level, 3);
  assert.deepEqual(act(r), piece('O', 0, 4, 14));
});

test('§10.7 CLEAN으로 밀린 블록이 조각과 겹치면 위로 밀어 올린다', () => {
  const b = emptyBoard();
  fillRow(b, 30); // 이 줄이 31행으로 내려오면서 조각(31행)과 겹친다
  const s = game({ board: b, items: ['CLEAN'], active: piece('O', 0, 4, 30) });
  // 조각은 30·31행을 차지하는데 30행은 이미 블록이다 → 애초에 겹치지 않는 자리로 옮긴다
  const s2 = { ...s, active: piece('O', 0, 4, 28) };
  const r = useItem(s2, 0);
  assert.equal(r.board[31][4], 'I', '30행이 31행으로 내려왔다');
  assert.deepEqual(act(r), piece('O', 0, 4, 28), '겹치지 않으면 조각은 그대로');

  // 겹치는 경우: 조각이 29·30행에 있고 30행이 내려와 31행이 되면 겹치지 않는다.
  // 실제 겹침은 조각 바로 위 행이 내려올 때 생긴다.
  const b2 = emptyBoard();
  fillRow(b2, 29);
  const s3 = game({ board: b2, items: ['CLEAN'], active: piece('O', 0, 4, 30) });
  const r3 = useItem(s3, 0);
  assert.equal(r3.board[30][4], 'I', '29행이 30행으로 내려와 조각과 겹쳤다');
  assert.equal(act(r3).y, 28, 'O는 2칸 높이라 2회 밀어 올려야 겹침이 풀린다(상한 4회)');
  assert.equal(r3.board[28][4], null, '밀어 올린 자리는 비어 있다');
  assert.equal(r3.board[29][4], null);
});

/* ────────────────────────── 8. 7-bag (§6.1) ────────────────────────── */

test('§6.1 rngNext — 순수·결정론, value ∈ [0,1), seed 0은 1로 치환', () => {
  const a = rngNext(12345);
  const b = rngNext(12345);
  assert.deepEqual(a, b);
  assert.ok(a.value >= 0 && a.value < 1);
  assert.deepEqual(rngNext(0), rngNext(1));
  assert.notEqual(rngNext(1).seed, rngNext(2).seed);
});

test('§6.1 refillBag — 7종 정확히 1회씩, 같은 시드면 같은 가방', () => {
  for (const seed of [1, 7, 424242]) {
    const { bag } = refillBag(seed);
    assert.equal(bag.length, 7);
    assert.deepEqual(bag.slice().sort(), PIECE_TYPES.slice().sort(), `시드 ${seed}`);
  }
  assert.deepEqual(refillBag(99), refillBag(99));
});

test('§6.1 큐 — 연속 7개마다 7종 1회씩, 같은 시드 → 같은 수열', () => {
  const play = (seed: number): PieceType[] => {
    let s = createGame({ seed });
    const seq: PieceType[] = [];
    for (let i = 0; i < 21; i++) {
      seq.push(act(s).type);
      s = hardDrop({ ...s, board: emptyBoard() }); // 보드를 비워 탑아웃 없이 21개를 뽑는다
    }
    return seq;
  };
  const seq = play(2026);
  assert.equal(seq.length, 21);
  for (let i = 0; i < 21; i += 7) {
    assert.deepEqual(seq.slice(i, i + 7).sort(), PIECE_TYPES.slice().sort(), `${i}번째 묶음`);
  }
  assert.deepEqual(play(2026), seq, '같은 시드 → 같은 수열');
  assert.notDeepEqual(play(777), seq, '다른 시드 → 다른 수열');
  assert.ok(createGame().queue.length >= PREVIEW_COUNT + 1);
});

/* ────────────────────────── 9. 락딜레이 (§7.4) ────────────────────────── */

test('§7.4 500ms에 고정 — 499ms에서는 아직 아니다', () => {
  assert.equal(LOCK_DELAY_MS, 500);
  const s = game({ active: piece('O', 0, 4, 38) });
  const a = tick(s, 499);
  assert.equal(a.lockTimer, 499);
  assert.equal(a.score, 0, '아직 고정 전');
  const b = tick(a, 1);
  assert.equal(b.score, 10, '500ms에서 고정 +10');
  assert.equal(b.board[39][4], 'O');
});

test('§7.4 리셋 상한 15 — 16회째는 타이머를 건드리지 않는다', () => {
  assert.equal(LOCK_RESET_LIMIT, 15);
  let s = game({ active: piece('O', 0, 4, 38), lowestY: 38, lockTimer: 100, lockResets: 0 });
  for (let i = 0; i < 15; i++) {
    s = move(s, i % 2 === 0 ? -1 : 1);
    assert.equal(s.lockResets, i + 1, `${i + 1}회째 리셋`);
    assert.equal(s.lockTimer, 0);
  }
  s = { ...s, lockTimer: 300 };
  const s16 = move(s, -1);
  assert.equal(act(s16).x, act(s).x - 1, '이동 자체는 성공한다');
  assert.equal(s16.lockResets, 15, '상한 유지');
  assert.equal(s16.lockTimer, 300, '타이머는 그대로');
});

test('§7.4 최저행 갱신 시 리셋 횟수 복구', () => {
  const s = game({ active: piece('O', 0, 4, 10), lowestY: 10, lockResets: 7 });
  const r = tick(s, 1000); // 레벨 1 중력 1000ms → 1칸 낙하
  assert.equal(act(r).y, 11);
  assert.equal(r.lowestY, 11);
  assert.equal(r.lockResets, 0);
});

test('§7.4 규칙 적용 순서 5→4 — 아래로 미는 킥 직후 lockResets === 1', () => {
  const b = emptyBoard();
  b[20][5] = 'I'; // 오프셋 1·2 차단
  b[19][5] = 'I'; // 오프셋 3 차단
  b[25][5] = 'I'; // 회전 후 접지 보장
  const s = game({ board: b, active: piece('J', 0, 4, 20), lowestY: 20, lockResets: 14, lockTimer: 250 });
  const r = rotate(s, 1);
  assert.deepEqual(act(r), piece('J', 1, 4, 22), '오프셋 4 (0,+2)가 채택된다');
  assert.equal(r.lowestY, 22);
  assert.equal(r.lockResets, 1, '0이면 4→5 순서 역전 FAIL');
  assert.equal(r.lockTimer, 0);
});

test('§7.4 접지가 풀리면 lockTimer는 null', () => {
  const s = game({ active: piece('O', 0, 4, 10), lockTimer: 300 });
  assert.equal(tick(s, 16).lockTimer, null);
});

/* ────────────────────────── 10. 중력·드롭 (§7.1~7.3) ────────────────────────── */

test('§7.1 큰 dtMs는 여러 칸 낙하, 막히면 누적을 비운다', () => {
  const s = game({ active: piece('O', 0, 4, 19) });
  const r = tick(s, 3000); // 레벨 1 = 1000ms/칸 → 3칸
  assert.equal(act(r).y, 22);
  assert.equal(r.gravityAcc, 0);

  const floorS = game({ active: piece('O', 0, 4, 38) });
  const f = tick(floorS, 3000);
  assert.equal(f.gravityAcc, 0, '막히면 누적 0');
});

test('§7.2 softDrop 전환은 gravityAcc를 0으로, 같은 값 재호출은 상태 동일', () => {
  assert.equal(SOFT_DROP_FACTOR, 20);
  const s = game({ active: piece('O', 0, 4, 19), gravityAcc: 400 });
  const on = softDrop(s, true);
  assert.equal(on.softDropping, true);
  assert.equal(on.gravityAcc, 0);
  assertIdle(softDrop(on, true), on, '같은 값 재호출');
  assertIdle(softDrop(s, false), s, '이미 꺼져 있는데 끄기');
});

test('§7.2 소프트드롭 간격 = round(중력/20), 바닥에서 즉시 고정되지 않는다', () => {
  const s = game({ active: piece('O', 0, 4, 36), softDropping: true });
  const r = tick(s, 100); // 간격 50ms → 2칸
  assert.equal(act(r).y, 38);
  assert.equal(r.score, 0, '소프트드롭은 점수 0');
  const grounded = tick(r, 100); // 접지 상태에서 계속 소프트드롭
  assert.ok(grounded.active, '락딜레이 없이 즉시 고정되지 않는다');
  assert.equal(grounded.lockTimer, 200, '접지 후에도 500ms까지는 락딜레이가 쌓일 뿐이다');
});

test('§7.3 하드드롭은 끝까지 내려 그 자리에서 즉시 고정', () => {
  const s = game({ active: piece('O', 0, 4, 19), lockTimer: null });
  const r = hardDrop(s);
  assert.equal(r.board[38][4], 'O');
  assert.equal(r.board[39][5], 'O');
  assert.ok(r.active, '다음 조각이 스폰됐다');
  assert.equal(act(r).y, 19);
});

test('§12.6 ghostY — 하드드롭 도달 지점, active가 null이면 null', () => {
  const s = game({ active: piece('O', 0, 4, 19) });
  assert.equal(ghostY(s), 38);
  const b = emptyBoard();
  fillRow(b, 30);
  assert.equal(ghostY({ ...s, board: b }), 28);
  assert.equal(ghostY({ ...s, active: null }), null);
});

/* ────────────────────────── 11. 레벨업 연출 (§9.3) ────────────────────────── */

test('§9.3 연출 중 tick은 fx만 줄인다 — y·lockTimer 불변', () => {
  const s = game({ active: piece('O', 0, 4, 19), fxLevelUpMs: 900, lockTimer: 123, gravityAcc: 0 });
  const r = tick(s, 500);
  assert.equal(r.fxLevelUpMs, 400);
  assert.equal(act(r).y, 19, '중력 정지');
  assert.equal(r.lockTimer, 123, '락딜레이 누적 정지, 값은 보존');
  assert.equal(r.gravityAcc, 0);
});

test('§9.3 연출이 끝나는 tick에서 남은 dt는 버린다(이월 없음)', () => {
  const s = game({ active: piece('O', 0, 4, 19), fxLevelUpMs: 400 });
  const r = tick(s, 500);
  assert.equal(r.fxLevelUpMs, 0);
  assert.equal(r.gravityAcc, 0, '남은 100ms를 중력으로 넘기지 않는다');
  assert.equal(act(r).y, 19);
  const next = tick(r, 1000);
  assert.equal(act(next).y, 20, '다음 tick부터 중력 재개');
});

test('§9.3 연출 중에도 이동·회전·하드드롭은 동작한다', () => {
  const s = game({ active: piece('T', 0, 4, 19), fxLevelUpMs: 900 });
  assert.equal(act(move(s, -1)).x, 3);
  assert.equal(act(rotate(s, 1)).rotation, 1);
  const dropped = hardDrop(s);
  assert.equal(dropped.score, 10, '하드드롭은 연출 중에도 즉시 고정');
});

test('§9.3 연출 중 하드드롭으로 다시 레벨업하면 900으로 재설정', () => {
  const s = game({ active: piece('O', 0, 4, 19), score: 90, level: 1, fxLevelUpMs: 120 });
  const r = hardDrop(s);
  assert.equal(r.level, 2);
  assert.equal(r.fxLevelUpMs, 900);
});

/* ────────────────────────── 12. 일시정지·게임오버 (§13) ────────────────────────── */

test('§13.2 일시정지 중 tick은 아무것도 하지 않는다(fx도 줄지 않는다)', () => {
  const s = togglePause(game({ active: piece('O', 0, 4, 19), fxLevelUpMs: 900 }));
  assert.equal(s.status, 'paused');
  assertIdle(tick(s, 5000), s, '일시정지 중 tick');
  assert.equal(togglePause(s).status, 'playing');
});

test('§13.1 Block Out — 스폰 자리가 막히면 게임오버(고정 점수는 이미 들어온 뒤)', () => {
  const b = emptyBoard();
  fillRow(b, 18, 9);
  fillRow(b, 19, 9);
  const s = game({ board: b, active: piece('O', 0, 0, 38) });
  const r = hardDrop(s);
  assert.equal(r.status, 'over');
  assert.equal(r.active, null);
  assert.equal(r.score, 10, '고정은 정상 처리된 뒤 다음 스폰에서 막혔다');
  const ev = r.events[r.events.length - 1];
  assert.deepEqual(ev, { type: 'gameOver', reason: 'blockout', score: 10 });
});

test('§13.1 Lock Out — 전부 y<20이면 +10도 줄삭제도 없다', () => {
  const b = emptyBoard();
  for (let y = 20; y < ROWS; y++) fillRow(b, y, 9);
  const s = game({ board: b, active: piece('O', 0, 0, 18), score: 240, lines: 12, level: 3 });
  const r = tick(s, 500);
  assert.equal(r.status, 'over');
  assert.equal(r.active, null);
  assert.equal(r.score, 240, '+10 없음');
  assert.equal(r.lines, 12);
  assert.equal(r.level, 3);
  assert.deepEqual(r.events, [{ type: 'gameOver', reason: 'lockout', score: 240 }]);
  assert.equal(r.board[18][0], 'O', '조각은 병합된 채로 남는다');
});

test('§13.1 게임오버 후 모든 함수가 상태를 그대로 반환', () => {
  const over: GameState = { ...game({ items: ['BOMB'] }), status: 'over', active: null };
  assertIdle(tick(over, 1000), over, 'tick');
  assertIdle(move(over, -1), over, 'move');
  assertIdle(rotate(over, 1), over, 'rotate');
  assertIdle(softDrop(over, true), over, 'softDrop');
  assertIdle(hardDrop(over), over, 'hardDrop');
  assertIdle(hold(over), over, 'hold');
  assertIdle(useItem(over, 0), over, 'useItem');
  assertIdle(summonItem(over), over, 'summonItem');
  assertIdle(togglePause(over), over, 'togglePause');
});

/* ────────────────────────── 13. 홀드 (§6.3) ────────────────────────── */

test('§6.3 홀드 — 첫 홀드는 큐에서 스폰, 두 번째는 잠금, 고정 시 해제', () => {
  const s = game({ hold: null, holdLocked: false, queue: ['T', 'S', 'Z', 'L'], active: piece('J', 0, 3, 19) });
  const h = hold(s);
  assert.equal(h.hold, 'J');
  assert.equal(act(h).type, 'T');
  assert.equal(h.holdLocked, true);
  assert.deepEqual(h.events, [{ type: 'hold', piece: 'J' }]);
  assert.equal(h.score, s.score, '홀드는 점수에 영향 없음');

  assertIdle(hold(h), h, '잠긴 홀드');

  const swapped = hold({ ...h, holdLocked: false });
  assert.equal(swapped.hold, 'T');
  assert.equal(act(swapped).type, 'J', '교환해 들어온 조각이 스폰된다');
  assert.deepEqual(swapped.queue, h.queue, '교환 경로는 큐를 소비하지 않는다');

  const locked = hardDrop(h);
  assert.equal(locked.holdLocked, false, '고정 시에만 해제');
});

test('§6.3 홀드는 락딜레이 상태를 새 조각 기준으로 초기화', () => {
  const s = game({ hold: null, holdLocked: false, active: piece('J', 0, 3, 30), lockTimer: 200, lockResets: 9, lowestY: 30 });
  const h = hold(s);
  assert.equal(h.lockTimer, null);
  assert.equal(h.lockResets, 0);
  assert.equal(h.lowestY, act(h).y);
});

/* ────────────────────────── 14. events 규약·불변성 (§14.1) ────────────────────────── */

test('§14.1 events는 누적되지 않는다 — 호출분만 담는다', () => {
  const s = createGame(); // events = [itemGain]
  const m = move(s, -1);
  assert.deepEqual(m.events, [{ type: 'move', dx: -1 }]);
  const r = rotate(m, 1);
  assert.deepEqual(r.events, [{ type: 'rotate', dir: 1 }]);
  const t = tick(r, 16);
  assert.deepEqual(t.events, []);
  const p = togglePause(t);
  assert.deepEqual(p.events, []);
});

test('§14.1 고정 절차의 이벤트 순서 = lock → lineClear → levelUp → itemGain', () => {
  const b = emptyBoard();
  for (let y = 36; y < 40; y++) fillRow(b, y, 9);
  const s = game({ board: b, active: piece('I', 1, 7, 20), score: 150, level: 2, items: [] });
  const r = hardDrop(s);
  assert.deepEqual(
    r.events.map((e) => e.type),
    ['lock', 'lineClear', 'levelUp', 'itemGain', 'itemGain', 'itemGain', 'itemGain'],
  );
});

test('§14.1 불변성 — 어떤 호출도 입력 상태를 변형하지 않는다', () => {
  const b = emptyBoard();
  fillRow(b, 39, 9);
  const s = game({ board: b, items: ['BAR', 'BOMB', 'CLEAN'], active: piece('T', 0, 4, 30), queue: ['I', 'J', 'L', 'O'] });
  const snap = JSON.stringify(s);
  const calls: Array<() => unknown> = [
    () => tick(s, 1200),
    () => tick(s, 60000),
    () => move(s, -1),
    () => move(s, 1),
    () => rotate(s, 1),
    () => rotate(s, -1),
    () => softDrop(s, true),
    () => hardDrop(s),
    () => hold(s),
    () => useItem(s, 0),
    () => useItem(s, 1),
    () => useItem(s, 2),
    () => summonItem({ ...s, items: [] }),
    () => togglePause(s),
    () => ghostY(s),
    () => createGame({ seed: 5 }),
  ];
  for (const c of calls) {
    c();
    assert.equal(JSON.stringify(s), snap, '입력 상태가 변했다');
  }
});

test('§14.1 상태는 JSON 스냅샷이 떠지는 순수 데이터다', () => {
  const s = hardDrop(game({ active: piece('O', 0, 4, 19) }));
  const clone = JSON.parse(JSON.stringify(s)) as GameState;
  assert.deepEqual(clone, s);
  const walk = (v: unknown): void => {
    assert.notEqual(typeof v, 'function');
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(s);
});

/* ────────────────────────── 15. 셸이 읽는 상수 (§14.3) ────────────────────────── */

test('§14.3 셸과 공유하는 상수값', () => {
  assert.equal(PREVIEW_COUNT, 3);
  assert.equal(DAS_MS, 167);
  assert.equal(ARR_MS, 33);
  assert.equal(STEP_MS, 1000 / 60);
  assert.equal(MAX_FRAME_MS, 100);
  assert.equal(ITEM_SLOTS, 3);
  assert.equal(FX_LEVELUP_MS, 900);
  // §14.4 한 프레임 최대 tick 횟수 6회 (QA 28)
  assert.equal(Math.ceil(MAX_FRAME_MS / STEP_MS), 6);
});

test('§14.5 무동작 호출도 events를 비운다 — 직전 호출의 events를 물고 오지 않는다', () => {
  // 실제 버그 시나리오: 고정으로 lock/levelUp events가 실린 상태에서
  // 일시정지 중 tick이 매 프레임 같은 events를 다시 내주면 셸이 소리를 반복한다.
  const locked = hardDrop(game({ active: piece('O', 0, 4, 19) }));
  assert.ok(locked.events.length > 0, '고정 호출에는 events가 실린다');

  const paused = togglePause(locked);
  assert.deepEqual(paused.events, []);
  let s = paused;
  for (let i = 0; i < 3; i++) {
    s = tick(s, STEP_MS);
    assert.deepEqual(s.events, [], '일시정지 중 tick은 매번 빈 events');
  }

  // 벽에 막힌 이동·잠긴 홀드·빈 슬롯도 마찬가지다.
  const wall = { ...locked, active: piece('O', 0, 0, 19) };
  assert.deepEqual(move(wall, -1).events, [], '벽에 막힌 이동');
  assert.deepEqual(hold({ ...locked, holdLocked: true }).events, [], '잠긴 홀드');
  assert.deepEqual(useItem({ ...locked, items: [] }, 0).events, [], '빈 슬롯');
  assert.deepEqual(softDrop({ ...locked, softDropping: false }, false).events, [], '같은 값 재호출');
  assert.deepEqual(tick({ ...locked, status: 'over' }, 16).events, [], '게임오버 중 tick');

  // events를 뺀 나머지 필드는 값이 같아야 한다.
  assertIdle(move(wall, -1), wall, '벽에 막힌 이동');
});

test('§2.2 줄삭제 판정은 40행 전체 — 버퍼(y<20) 안에서 완성된 줄도 지워진다', () => {
  const b = emptyBoard();
  fillRow(b, 19, 9);  // 버퍼 마지막 행을 9열만 남기고 채운다
  b[23][9] = 'I';     // 세로 I가 19~22행에 걸쳐 멈추도록 받쳐 준다
  const s = game({ board: b, active: piece('I', 1, 7, 19) });
  const r = hardDrop(s);

  // 셀 일부가 y>=20이므로 Lock Out이 아니다(§7.5-2). 줄삭제까지 진행돼야 한다.
  assert.equal(r.status, 'playing', 'Lock Out이 아니다');
  const ev = r.events.find((e) => e.type === 'lineClear');
  assert.ok(ev && ev.type === 'lineClear', '버퍼 행이 지워지지 않으면 lineClear 이벤트 자체가 없다');
  assert.deepEqual(ev.rows, [19], '버퍼 행 y=19가 삭제 대상에 들어간다');
  assert.equal(ev.count, 1);
  assert.equal(r.score, 10 + LINE_SCORE[1]);
  assert.equal(r.lines, 1);

  // 19행이 사라지고 위가 1칸씩 내려온다. 19행 아래는 그대로다.
  assert.equal(r.board[19].every((c) => c === null), true, '지워진 자리에 빈 행이 내려왔다');
  assert.equal(r.board[20][9], 'I', '20행 이하는 그대로');
  assert.equal(r.board[23][9], 'I');
  assert.equal(r.board[0].every((c) => c === null), true);
});

test('§2.2 버퍼 행과 표시 행이 걸쳐 있어도 동시에 지워진다 (y=19 + y=20)', () => {
  const b = emptyBoard();
  fillRow(b, 19, 9);
  fillRow(b, 20, 9);
  b[23][9] = 'I';
  const s = game({ board: b, active: piece('I', 1, 7, 19) });
  const r = hardDrop(s);

  const ev = r.events.find((e) => e.type === 'lineClear');
  assert.ok(ev && ev.type === 'lineClear');
  assert.deepEqual(ev.rows, [19, 20], '버퍼 19행과 표시 20행이 함께 삭제된다');
  assert.equal(ev.count, 2, '버퍼 행을 빼고 세면 1이 되어 FAIL이다');
  assert.equal(ev.points, LINE_SCORE[2]);
  assert.equal(r.score, 10 + LINE_SCORE[2], '2줄 = 150점');
  assert.equal(r.lines, 2);
  assert.equal(r.board[21][9], 'I', '남은 조각 셀은 그대로');
});

/* ────────────────────────── 16. 사용자 요구: 첫 레벨업 체감 시간 ────────────────────────── */

// prompt.md(1차 소스): "초등학생이 30~60초 안에 첫 레벨업을 겪도록 점수를 잘게 나눕니다."
// §9.1이 "QA는 실측 대상으로 삼지 마라"로 닫아 둔 탓에 이 요구를 재는 게이트가 없었다.
// 규칙(레벨 식)을 바꾸는 게 아니라, 현재 상수 조합이 요구 구간 안에 있는지를 회귀로 고정한다.
//
// 표준 템포 = 조각당 4000ms (관례값) — 보통 초등학생이 조각 하나를 놓는 데 쓰는 시간.
// 이 값 자체가 관례값이며 실사용자 관측이 아니다.
// 시간은 전부 주입값(STEP_MS 누적)으로 잰다. 벽시계를 쓰면 코어 순수성이 깨지고 CI에서 흔들린다.
const TEMPO_MS = 4000;      // (관례값) 보통
const TEMPO_FAST_MS = 3000; // (관례값) 빠른 초등학생 = 요구 구간의 아래 끝
const TEMPO_SLOW_MS = 5000; // (관례값) 느긋함 = 요구 구간의 위 끝

function msToFirstLevelUp(tempoMs: number, seed = 1): number {
  let s = createGame({ seed });
  let elapsed = 0;
  let sinceDrop = 0;
  while (s.level < 2) {
    s = tick(s, STEP_MS);
    elapsed += STEP_MS;
    sinceDrop += STEP_MS;
    if (sinceDrop >= tempoMs) {
      s = hardDrop(s);
      sinceDrop = 0;
    }
    assert.notEqual(s.status, 'over', `템포 ${tempoMs}ms: 레벨업 전에 게임오버`);
    assert.ok(elapsed < 300000, `템포 ${tempoMs}ms: 5분 안에 첫 레벨업에 도달하지 못했다`);
  }
  return elapsed;
}

test('prompt.md 요구 — 표준 템포(조각당 4000ms)에서 첫 레벨업이 30~60초 안에 온다', () => {
  const ms = msToFirstLevelUp(TEMPO_MS);
  assert.ok(ms >= 30000, `첫 레벨업이 너무 빠르다: ${(ms / 1000).toFixed(1)}초 (30초 이상이어야 한다)`);
  assert.ok(ms <= 60000, `첫 레벨업이 너무 느리다: ${(ms / 1000).toFixed(1)}초 (60초 이하여야 한다)`);
  // 첫 레벨업 = 100점 = 조각 10개(줄삭제 없을 때). LOCK_SCORE·POINTS_PER_LEVEL을 건드리면 여기서 깨진다.
  assert.equal(Math.ceil(POINTS_PER_LEVEL / LOCK_SCORE), 10);
});

test('prompt.md 요구 — 요구 구간의 양 끝: 3000ms 템포는 30초 이상, 5000ms 템포는 60초 이하', () => {
  const fast = msToFirstLevelUp(TEMPO_FAST_MS);
  assert.ok(fast >= 30000, `빠른 템포에서도 30초는 걸려야 한다: ${(fast / 1000).toFixed(1)}초`);
  const slow = msToFirstLevelUp(TEMPO_SLOW_MS);
  assert.ok(slow <= 60000, `느긋한 템포에서도 60초 안에 와야 한다: ${(slow / 1000).toFixed(1)}초`);
  assert.ok(fast < slow, '템포가 느릴수록 첫 레벨업도 늦다');
});

/* ────────────────────────── 17. 아이템 구제 호출 (§10.8) ────────────────────────── */

test('§10.8 0칸에서 호출하면 긴막대 1개 + itemGain 이벤트 + rescueLevel 기록', () => {
  const s = game({ items: [], level: 3, rescueLevel: 0 });
  const r = summonItem(s);
  assert.deepEqual(r.items, ['BAR']);
  assert.equal(r.rescueLevel, 3, '이번 레벨에 썼다고 기록');
  assert.deepEqual(r.events, [{ type: 'itemGain', item: 'BAR', discarded: false }], '새 이벤트 종류를 만들지 않는다');
  assert.equal(r.score, s.score, '점수는 바뀌지 않는다');
  assert.equal(createGame().rescueLevel, 0, 'createGame은 0');
});

test('§10.8 같은 레벨에서 두 번째 호출은 막힌다', () => {
  const first = summonItem(game({ items: [], level: 3, rescueLevel: 0 }));
  const spent = { ...first, items: [] }; // 불러온 긴막대를 다 썼다
  assertIdle(summonItem(spent), spent, '같은 레벨 두 번째 호출');
  assert.deepEqual(summonItem(spent).items, [], '두 번째는 아무것도 주지 않는다');
});

test('§10.8 칸이 1개라도 남아 있으면 호출되지 않는다 (0칸 조건)', () => {
  const stock: ItemType[][] = [['BAR'], ['BAR', 'BOMB'], ['BAR', 'BOMB', 'CLEAN']];
  for (const items of stock) {
    const s = game({ items, level: 3, rescueLevel: 0 });
    assertIdle(summonItem(s), s, `${items.length}칸 보유`);
    assert.equal(summonItem(s).rescueLevel, 0, '막힌 호출은 레벨을 기록하지 않는다');
  }
});

test('§10.8 레벨이 오르면 다시 부를 수 있다 — 레벨업은 rescueLevel을 초기화하지 않는다', () => {
  const used = summonItem(game({ items: [], level: 1, rescueLevel: 0 }));
  assert.equal(used.rescueLevel, 1);

  // 실제 레벨업 경로: 90점 + 고정 10점 → 100점 → 레벨 2. rescueLevel은 그대로여야 한다.
  const leveling = hardDrop({ ...used, active: piece('O', 0, 4, 19), score: 90, items: [] });
  assert.equal(leveling.level, 2);
  assert.equal(leveling.rescueLevel, 1, '레벨업이 rescueLevel을 건드리면 안 된다');

  // 레벨 2의 정규 지급 아이템까지 다 쓴 뒤에는 다시 부를 수 있다.
  const again = summonItem({ ...leveling, items: [] });
  assert.deepEqual(again.items, ['BAR']);
  assert.equal(again.rescueLevel, 2);
});

test('§10.8 일시정지·게임오버 중 불가, 레벨업 연출 중에는 가능', () => {
  const base = game({ items: [], level: 2, rescueLevel: 0 });

  const paused = togglePause(base);
  assertIdle(summonItem(paused), paused, '일시정지 중');

  const over: GameState = { ...base, status: 'over', active: null };
  assertIdle(summonItem(over), over, '게임오버 중');

  const fx = { ...base, fxLevelUpMs: 900 };
  const r = summonItem(fx);
  assert.deepEqual(r.items, ['BAR'], '연출 중에는 부를 수 있다');
  assert.equal(r.fxLevelUpMs, 900, '연출 타이머는 건드리지 않는다');
});

test('§10.8 폭탄은 어떤 레벨에서도 나오지 않는다 — 항상 BAR', () => {
  for (const level of [5, 10, 15, 20]) {
    assert.equal(itemForLevel(level), 'BOMB', `대조군: 레벨 ${level}의 정규 지급은 폭탄이다`);
    const r = summonItem(game({ items: [], level, rescueLevel: 0 }));
    assert.deepEqual(r.items, ['BAR'], `레벨 ${level} 구제 호출은 긴막대 고정`);
  }
  // 1..20 어느 레벨에서도 구제 호출 결과는 BAR 하나뿐이다.
  for (let level = 1; level <= 20; level++) {
    assert.deepEqual(summonItem(game({ items: [], level, rescueLevel: 0 })).items, ['BAR'], `레벨 ${level}`);
  }
});

test('§10.8 무동작 호출은 events를 비운다 (§14.5)', () => {
  const locked = hardDrop(game({ active: piece('O', 0, 4, 19), items: ['BAR'] }));
  assert.ok(locked.events.length > 0, '직전 호출에는 events가 실려 있다');
  assert.deepEqual(summonItem(locked).events, [], '칸이 남아 있어 막힌 호출');
  const spent = summonItem({ ...locked, items: [] });
  assert.deepEqual(summonItem({ ...spent, items: [] }).events, [], '이번 레벨에 이미 쓴 호출');
});
