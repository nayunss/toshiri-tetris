// 소리 8종 — WebAudio 합성. 외부 음원 파일 0. 전 수치 (관례값) §12.10
export type SoundName =
  | 'move'
  | 'rotate'
  | 'lock'
  | 'lineClear'
  | 'levelUp'
  | 'itemGain'
  | 'itemUse'
  | 'gameOver';

interface Note {
  wave: OscillatorType;
  f0: number;
  f1: number;
  ms: number;
  at: number; // 시작 오프셋 ms
}

const SOUNDS: Record<SoundName, { gain: number; notes: Note[] }> = {
  move: { gain: 0.06, notes: [{ wave: 'square', f0: 220, f1: 220, ms: 40, at: 0 }] },
  rotate: { gain: 0.08, notes: [{ wave: 'triangle', f0: 440, f1: 560, ms: 60, at: 0 }] },
  lock: { gain: 0.1, notes: [{ wave: 'square', f0: 160, f1: 110, ms: 80, at: 0 }] },
  lineClear: {
    gain: 0.12,
    notes: [
      { wave: 'sine', f0: 660, f1: 660, ms: 90, at: 0 },
      { wave: 'sine', f0: 880, f1: 880, ms: 90, at: 60 },
      { wave: 'sine', f0: 1320, f1: 1320, ms: 90, at: 120 },
    ],
  },
  levelUp: {
    gain: 0.14,
    notes: [
      { wave: 'sine', f0: 523, f1: 523, ms: 110, at: 0 },
      { wave: 'sine', f0: 659, f1: 659, ms: 110, at: 90 },
      { wave: 'sine', f0: 784, f1: 784, ms: 110, at: 180 },
      { wave: 'sine', f0: 1047, f1: 1047, ms: 110, at: 270 },
    ],
  },
  itemGain: { gain: 0.1, notes: [{ wave: 'triangle', f0: 880, f1: 1320, ms: 120, at: 0 }] },
  itemUse: { gain: 0.1, notes: [{ wave: 'sawtooth', f0: 300, f1: 900, ms: 180, at: 0 }] },
  gameOver: { gain: 0.12, notes: [{ wave: 'sawtooth', f0: 400, f1: 120, ms: 600, at: 0 }] },
};

const MASTER_GAIN = 0.5;
const REPEAT_GUARD_S = 0.05; // 같은 소리 50ms 억제 (관례값)

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
const lastAt: Partial<Record<SoundName, number>> = {};

/** 첫 키 입력에서 호출 — 브라우저 자동재생 정책 대응. */
export function wakeAudio() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER_GAIN;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
}

export function setMuted(next: boolean) {
  muted = next;
  if (master) master.gain.value = muted ? 0 : MASTER_GAIN;
}

export function play(name: SoundName) {
  if (!ctx || !master) return;
  const now = ctx.currentTime;
  if (now - (lastAt[name] ?? -1) < REPEAT_GUARD_S) return;
  lastAt[name] = now;
  const def = SOUNDS[name];
  for (const n of def.notes) {
    const t0 = now + n.at / 1000;
    const t1 = t0 + n.ms / 1000;
    const osc = ctx.createOscillator();
    osc.type = n.wave;
    osc.frequency.setValueAtTime(n.f0, t0);
    if (n.f1 !== n.f0) osc.frequency.linearRampToValueAtTime(n.f1, t1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(def.gain, t0 + 0.005); // attack 5ms
    g.gain.exponentialRampToValueAtTime(0.0001, t1);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t1 + 0.02);
  }
}
