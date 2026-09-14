// 키보드 · 터치 입력과 DAS/ARR 누적. 규칙 판정은 없다(§3) — 코어 함수를 부르기만 한다.
import { DAS_MS, ARR_MS } from '../core/tetris';
import type { ItemSlot, Status } from '../core/types';

export interface InputActions {
  move: (dx: -1 | 1) => void;
  rotate: () => void;
  softDrop: (on: boolean) => void;
  hardDrop: () => void;
  hold: () => void;
  useItem: (slot: ItemSlot) => void;
  togglePause: () => void;
  restart: () => void;
  toggleMute: () => void;
  status: () => Status;
  wake: () => void; // 첫 입력에서 AudioContext.resume()
}

const HANDLED = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Space',
  'KeyC',
  'Digit1',
  'Digit2',
  'Digit3',
  'Numpad1',
  'Numpad2',
  'Numpad3',
  'KeyP',
  'KeyR',
  'KeyM',
]);
const GLOBAL = new Set(['KeyP', 'KeyR', 'KeyM']);
const ITEM_KEY: Record<string, ItemSlot> = {
  Digit1: 0,
  Digit2: 1,
  Digit3: 2,
  Numpad1: 0,
  Numpad2: 1,
  Numpad3: 2,
};

export function createInput(a: InputActions) {
  let dirs: (-1 | 1)[] = []; // 나중에 누른 쪽이 이긴다 (관례값) §12.13
  let charge = 0; // 현재 방향을 누르고 있은 시간
  let fired = 1; // 그동안 발생시킨 이동 횟수

  const dir = () => (dirs.length ? dirs[dirs.length - 1] : 0);

  const press = (d: -1 | 1) => {
    if (dirs.includes(d)) return;
    dirs.push(d);
    charge = 0;
    fired = 1;
    a.move(d);
  };

  const release = (d: -1 | 1) => {
    const wasTop = dir() === d;
    dirs = dirs.filter((x) => x !== d);
    const now = dir();
    if (wasTop && now !== 0) {
      // 이긴 키를 떼면 남은 방향으로 전환하고 DAS를 새로 시작한다
      charge = 0;
      fired = 1;
      a.move(now);
    }
  };

  const releaseAll = () => {
    dirs = [];
    a.softDrop(false);
  };

  /** 매 프레임 호출. DAS 167ms 뒤 ARR 33ms 간격 — 프레임이 밀려도 횟수로 보정한다. */
  const update = (dtMs: number) => {
    const d = dir();
    if (d === 0 || a.status() !== 'playing') return;
    charge += dtMs;
    const want = charge >= DAS_MS ? 1 + Math.floor((charge - DAS_MS) / ARR_MS) : 1;
    while (fired < want) {
      a.move(d);
      fired++;
    }
  };

  const allowed = (code: string) => {
    const st = a.status();
    if (st === 'playing') return true;
    if (st === 'paused') return GLOBAL.has(code);
    return code === 'KeyR' || code === 'KeyM'; // over
  };

  const keydown = (e: KeyboardEvent) => {
    if (!HANDLED.has(e.code) || !allowed(e.code)) return;
    e.preventDefault(); // Space 스크롤·ArrowDown 창 내림 차단. Tab·F5는 살린다
    a.wake();
    if (e.code === 'ArrowLeft') return press(-1);
    if (e.code === 'ArrowRight') return press(1);
    if (e.code === 'ArrowDown') return a.softDrop(true);
    if (e.repeat) return; // 1회성 입력은 키 반복을 무시한다
    switch (e.code) {
      case 'ArrowUp':
        return a.rotate();
      case 'Space':
        return a.hardDrop();
      case 'KeyC':
        return a.hold();
      case 'KeyP':
        return a.togglePause();
      case 'KeyR':
        return a.restart();
      case 'KeyM':
        return a.toggleMute();
      default:
        return a.useItem(ITEM_KEY[e.code]);
    }
  };

  const keyup = (e: KeyboardEvent) => {
    if (e.code === 'ArrowLeft') release(-1);
    else if (e.code === 'ArrowRight') release(1);
    else if (e.code === 'ArrowDown') a.softDrop(false);
  };

  return { keydown, keyup, update, press, release, releaseAll };
}
