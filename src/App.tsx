import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  createGame,
  tick,
  move,
  rotate,
  softDrop,
  hardDrop,
  hold,
  useItem,
  summonItem,
  togglePause,
  pieceCells,
  boxSize,
  PREVIEW_COUNT,
  ITEM_SLOTS,
  FX_LEVELUP_MS,
  STEP_MS,
  MAX_FRAME_MS,
} from './core/tetris';
import type { GameState, ItemSlot, ItemType, PieceType, Rotation, Status } from './core/types';
import { createRenderer, newFx, PIECE_COLORS, CELL, TOP } from './shell/render';
import { createInput } from './shell/input';
import type { InputActions } from './shell/input';
import { play, setMuted, wakeAudio } from './shell/audio';

const ITEMS: Record<ItemType, { name: string; obj: string }> = {
  BAR: { name: '긴막대', obj: '긴막대를' },
  SQUARE: { name: '네모', obj: '네모를' },
  CLEAN: { name: '바닥청소', obj: '바닥청소를' },
  BOMB: { name: '폭탄', obj: '폭탄을' },
};

// 레벨업 노출은 코어의 FX_LEVELUP_MS와 같은 값이어야 한다(900을 두 곳에 적지 않는다). 700은 (관례값) §12.9
const CLIP_MS = { jump: FX_LEVELUP_MS, carrot: 700 };

interface Hud {
  score: number;
  level: number;
  lines: number;
  status: Status;
  hold: PieceType | null;
  holdLocked: boolean;
  items: ItemType[];
  queue: PieceType[];
  canSummon: boolean; // 표시용. 실제 판정은 코어의 summonItem이 한다(§10.8)
}

interface Api extends InputActions {
  press: (d: -1 | 1) => void;
  release: (d: -1 | 1) => void;
}

/** 바닥청소 아이콘 — 인라인 SVG(외부 파일 없음). 남는 두 줄 + 빗자루 + 쓸려 나가는 맨 아래 줄. */
function CleanIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
      <g stroke="#3A2B1F" strokeWidth="1.4" fill="none">
        <rect x="2.2" y="2.4" width="8" height="5.4" rx="1.2" />
        <rect x="12.6" y="2.4" width="8" height="5.4" rx="1.2" />
      </g>
      <path d="M20 9.6 L13.6 16" stroke="#3A2B1F" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M14.6 13.8 L9.8 18.6 L12.2 21 L17 16.2 Z" fill="#A32F5B" />
      <path d="M2 22.2 h20" stroke="#A32F5B" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M4.4 17.4 l-2 2 M7.6 18.4 l-2 2" stroke="#3A2B1F" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** 폭탄 아이콘 — 인라인 SVG. 둥근 덩어리 실루엣이라 CLEAN(가로 바닥 줄)과 한눈에 갈린다. */
function BombIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
      <circle cx="10.2" cy="15.6" r="7" fill="#3A2B1F" />
      <circle cx="7.4" cy="12.8" r="1.7" fill="#FFF6EA" opacity="0.5" />
      <rect x="12.6" y="7.4" width="4.4" height="3.4" rx="0.9" fill="#3A2B1F" transform="rotate(38 14.8 9.1)" />
      <path d="M17.4 7.6 C19.2 6.4 19.6 5.2 19.4 3.9" stroke="#3A2B1F" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <circle cx="19.6" cy="4.2" r="2" fill="#A32F5B" />
      <g stroke="#A32F5B" strokeWidth="1.3" strokeLinecap="round">
        <path d="M19.6 0.9 v1.1 M19.6 6.4 v1.1 M16.3 4.2 h1.1 M21.9 4.2 h1.1" />
      </g>
    </svg>
  );
}

/** 아이템 칸 아이콘. BAR·SQUARE는 보드에 실제로 나타나는 조각이라 미리보기와 같은 PieceGrid 경로를
 *  재사용하고, CLEAN·BOMB은 대응 블록이 없는 '효과'라 인라인 SVG다(§12.14.5). */
function ItemIcon({ item }: { item: ItemType }) {
  if (item === 'BAR') return <PieceGrid type="I" rotation={1} />; // 세로 막대
  if (item === 'SQUARE') return <PieceGrid type="O" />;
  if (item === 'CLEAN') return <CleanIcon />;
  return <BombIcon />;
}

/** 조각 1개를 DOM 그리드로 그린다(미리보기·홀드·아이템 아이콘 공용). 셀 한 변은 CSS `--s`(기본 24px).
 *  조각은 항상 알파 1.0이다 — 잠김은 슬롯이 표시한다(§12.8.1). */
function PieceGrid({ type, rotation = 0 }: { type: PieceType | null; rotation?: Rotation }) {
  if (!type) return <div className="grid empty-slot" />;
  const n = boxSize(type);
  const filled = new Set(pieceCells(type, rotation).map(([dx, dy]) => dy * n + dx));
  return (
    <div className="grid" style={{ gridTemplateColumns: `repeat(${n}, var(--s, 24px))` }}>
      {Array.from({ length: n * n }, (_, i) => (
        <div
          key={i}
          className={`cell${filled.has(i) ? '' : ' hole'}${type === 'O' ? ' o' : ''}`}
          style={filled.has(i) ? { backgroundColor: PIECE_COLORS[type] } : undefined}
        />
      ))}
    </div>
  );
}

export default function App() {
  const stateRef = useRef<GameState>(undefined as unknown as GameState);
  if (stateRef.current === undefined) stateRef.current = createGame({ seed: Date.now() >>> 0 });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const jumpRef = useRef<HTMLDivElement>(null);
  const carrotRef = useRef<HTMLDivElement>(null);
  const politeRef = useRef<HTMLDivElement>(null);
  const assertiveRef = useRef<HTMLDivElement>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);

  const [hud, setHud] = useState<Hud>(() => {
    const s = stateRef.current;
    return {
      score: s.score,
      level: s.level,
      lines: s.lines,
      status: s.status,
      hold: s.hold,
      holdLocked: s.holdLocked,
      items: [...s.items],
      queue: s.queue.slice(0, PREVIEW_COUNT),
      canSummon: s.items.length === 0 && s.rescueLevel !== s.level && s.status === 'playing',
    };
  });
  const [muted, setMutedUi] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const draw = createRenderer(canvas);
    const fx = newFx();
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');

    // --- aria-live (§12.11 목록에 있는 것만 발화한다) ---
    let ariaTimer = 0;
    let pending = '';
    const say = (msg: string) => {
      pending = msg;
      window.clearTimeout(ariaTimer);
      ariaTimer = window.setTimeout(() => {
        if (politeRef.current) politeRef.current.textContent = pending;
      }, 200); // 200ms 안에 여러 문구가 오면 마지막 것만
    };
    const shout = (msg: string) => {
      if (assertiveRef.current) assertiveRef.current.textContent = msg;
    };

    let toastTimer = 0;
    const toast = (msg: string) => {
      const el = toastRef.current;
      if (!el) return;
      el.textContent = msg;
      el.hidden = false;
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => {
        el.hidden = true;
      }, 1500);
    };

    // --- 토끼 webm 오버레이 + 폴백 (§12.9) ---
    const videos = [jumpRef.current, carrotRef.current].map(
      (w) => w?.querySelector('video') as HTMLVideoElement | null,
    );
    let fallback = document.createElement('video').canPlayType('video/webm; codecs="vp9"') === '';
    const markFallback = () => {
      fallback = true;
      jumpRef.current?.classList.add('fallback');
      carrotRef.current?.classList.add('fallback');
    };
    if (fallback) markFallback();
    for (const v of videos) v?.addEventListener('error', markFallback);
    // 1200ms 안에 재생 준비가 안 되면 폴백 고정 (관례값)
    const probeTimer = window.setTimeout(() => {
      if (videos.some((v) => !v || v.readyState < 3)) markFallback();
    }, 1200);

    const clipTimers = { jump: 0, carrot: 0 };
    const showClip = (kind: 'jump' | 'carrot') => {
      const wrap = kind === 'jump' ? jumpRef.current : carrotRef.current;
      if (!wrap) return;
      wrap.hidden = false;
      wrap.classList.remove('show');
      void wrap.offsetWidth; // 연타 시 페이드 애니메이션을 처음부터 다시
      wrap.classList.add('show');
      const v = wrap.querySelector('video');
      if (v && !fallback && !mql.matches) {
        v.currentTime = 0;
        void v.play().catch(markFallback);
      }
      window.clearTimeout(clipTimers[kind]);
      clipTimers[kind] = window.setTimeout(() => {
        v?.pause(); // 클립은 5.166초지만 노출은 900/700ms — 앞부분만 재생한다
        wrap.hidden = true;
        wrap.classList.remove('show');
      }, CLIP_MS[kind]);
    };

    // --- 코어 이벤트 소비 (연출 표현만. 판정은 코어가 했다) ---
    const drain = (s: GameState) => {
      for (const ev of s.events) {
        switch (ev.type) {
          case 'move':
            play('move');
            break;
          case 'rotate':
            play('rotate');
            break;
          case 'hold':
            play('rotate'); // 홀드 전용 소리를 만들면 8종을 넘긴다
            say(`맡긴 조각: ${ev.piece}`); // §12.11 7번 문구(예시 문구를 화면 라벨과 맞춤)
            break;
          case 'lock':
            play('lock');
            break;
          case 'lineClear': {
            play('lineClear');
            say(`${ev.count}줄 삭제, ${ev.points}점`);
            const row = Math.max(...ev.rows);
            fx.popups.push({
              t0: performance.now(),
              text: `+${ev.points}`,
              y: (row - TOP) * CELL,
            });
            break;
          }
          case 'levelUp':
            play('levelUp');
            say(`레벨 ${ev.level}`);
            fx.levelUp = { t0: performance.now(), level: ev.level };
            showClip('jump');
            break;
          case 'itemGain':
            play('itemGain');
            say(
              ev.discarded
                ? `아이템 칸이 꽉 차서 ${ITEMS[ev.item].obj} 받지 못했습니다`
                : `${ITEMS[ev.item].name} 획득`,
            );
            if (ev.discarded) toast('아이템 칸이 꽉 찼어요');
            break;
          case 'itemUse':
            play('itemUse');
            say(`${ITEMS[ev.item].name} 사용`);
            showClip('carrot');
            break;
          case 'itemFail': // 소리 없음 (§12.10)
            say(`자리가 없어 ${ITEMS[ev.item].obj} 쓰지 못했습니다`);
            toast(`자리가 없어 ${ITEMS[ev.item].obj} 쓰지 못했어요`);
            break;
          case 'gameOver':
            play('gameOver');
            shout(
              `게임 오버. 최종 점수 ${ev.score}점, 레벨 ${s.level}. R 키를 누르면 다시 시작합니다`,
            );
            break;
        }
      }
    };

    const apply = (next: GameState) => {
      stateRef.current = next;
      drain(next);
    };
    apply(stateRef.current); // createGame이 낸 첫 itemGain(긴막대) 소비

    let hudKey = '';
    const syncHud = () => {
      const s = stateRef.current;
      const key = `${s.score}|${s.level}|${s.lines}|${s.status}|${s.hold}|${s.holdLocked}|${s.items.join(',')}|${s.queue.slice(0, PREVIEW_COUNT).join(',')}|${s.rescueLevel}`;
      if (key === hudKey) return;
      hudKey = key;
      setHud({
        score: s.score,
        level: s.level,
        lines: s.lines,
        status: s.status,
        hold: s.hold,
        holdLocked: s.holdLocked,
        items: [...s.items],
        queue: s.queue.slice(0, PREVIEW_COUNT),
        canSummon: s.items.length === 0 && s.rescueLevel !== s.level && s.status === 'playing',
      });
    };

    let mutedNow = false;
    const actions: InputActions = {
      move: (dx) => apply(move(stateRef.current, dx)),
      rotate: () => apply(rotate(stateRef.current, 1)),
      softDrop: (on) => apply(softDrop(stateRef.current, on)),
      hardDrop: () => apply(hardDrop(stateRef.current)),
      // 막힌 조작은 침묵하지 않는다(§12.11.1). 판정은 코어가 낸 events로 한다 — 셸이 다시 계산하지 않는다
      hold: () => {
        const s = stateRef.current;
        const next = hold(s);
        apply(next);
        if (next.events.length === 0 && s.status === 'playing') {
          toast('이번 조각은 이미 맡겼어요');
          say('이번 조각은 이미 맡겼어요');
        }
      },
      // 1번 칸이 비었으면 같은 키가 '구제 호출'이 된다(§10.8). 가능 여부 판정은 코어가 한다
      useItem: (slot) => {
        const s = stateRef.current;
        const empty = !s.items[slot];
        // 빈 1번 칸은 먼저 구제 호출을 시도하고(§10.8), 그것마저 무동작일 때만 안내한다(§12.11.1)
        const next = slot === 0 && s.items.length === 0 ? summonItem(s) : useItem(s, slot);
        apply(next);
        if (next.events.length > 0) {
          if (slot === 0 && s.items.length === 0) say('긴막대를 불렀어요');
        } else if (empty && s.status === 'playing') {
          toast('지금은 아이템이 없어요');
          say('지금은 아이템이 없어요');
        }
      },
      togglePause: () => {
        apply(togglePause(stateRef.current));
        say(stateRef.current.status === 'paused' ? '일시정지' : '계속');
      },
      restart: () => {
        fx.levelUp = null;
        fx.popups.length = 0;
        apply(createGame({ seed: Date.now() >>> 0 }));
      },
      toggleMute: () => {
        mutedNow = !mutedNow;
        setMuted(mutedNow);
        setMutedUi(mutedNow);
        say(mutedNow ? '소리 끔' : '소리 켬');
      },
      status: () => stateRef.current.status,
      wake: wakeAudio,
    };
    const input = createInput(actions);
    // 버튼·터치도 키보드와 같은 경로를 쓴다
    apiRef.current = { ...actions, press: input.press, release: input.release };

    // --- 고정 타임스텝 루프 (§14.4) ---
    let last = performance.now();
    let acc = 0;
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(now - last, MAX_FRAME_MS); // 탭 복귀 시 while 폭주 방지
      last = now;
      input.update(dt);
      acc += dt;
      while (acc >= STEP_MS) {
        apply(tick(stateRef.current, STEP_MS));
        acc -= STEP_MS;
      }
      draw(stateRef.current, fx, now, mql.matches);
      syncHud();
    };
    raf = requestAnimationFrame(frame);

    const onBlur = () => input.releaseAll();
    window.addEventListener('keydown', input.keydown);
    window.addEventListener('keyup', input.keyup);
    window.addEventListener('blur', onBlur);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', input.keydown);
      window.removeEventListener('keyup', input.keyup);
      window.removeEventListener('blur', onBlur);
      for (const v of videos) v?.removeEventListener('error', markFallback);
      window.clearTimeout(ariaTimer);
      window.clearTimeout(toastTimer);
      window.clearTimeout(probeTimer);
      window.clearTimeout(clipTimers.jump);
      window.clearTimeout(clipTimers.carrot);
      apiRef.current = null;
    };
  }, []);

  const go = (fn: (a: Api) => void) => {
    const a = apiRef.current;
    if (!a) return;
    a.wake();
    fn(a);
  };
  /** 터치 타깃도 DAS/ARR을 그대로 탄다(키보드와 같은 경로). */
  const pressProps = (d: -1 | 1) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      e.preventDefault();
      go((a) => a.press(d));
    },
    onPointerUp: () => go((a) => a.release(d)),
    onPointerLeave: () => go((a) => a.release(d)),
    onPointerCancel: () => go((a) => a.release(d)),
  });

  return (
    <>
      {/* 토끼 레이어 — 블러·스크림 없이 앱 열 바깥 여백에만 놓는다(§12.14.8) */}
      <div className="bunny" aria-hidden="true" />
      <div className="app">
      <h1 className="title">🐰 토시리 테트리스</h1>
      <header className="panel header">
        <dl className="stats">
          <div>
            <dt>SCORE</dt>
            <dd>{hud.score}</dd>
          </div>
          <div>
            <dt>LEVEL</dt>
            <dd>{hud.level}</dd>
          </div>
          <div>
            <dt>LINES</dt>
            <dd>{hud.lines}</dd>
          </div>
        </dl>
        <div className="sys">
          <button type="button" onClick={() => go((a) => a.togglePause())}>
            {hud.status === 'paused' ? '계속 (P)' : '일시정지 (P)'}
          </button>
          <button type="button" onClick={() => go((a) => a.restart())}>
            다시 하기 (R)
          </button>
          <button type="button" aria-pressed={muted} onClick={() => go((a) => a.toggleMute())}>
            {muted ? '소리 켜기 (M)' : '소리 끄기 (M)'}
          </button>
        </div>
      </header>

      <div className="stage">
        <aside className="side">
          <section className="panel">
            <h2>홀드 (C)</h2>
            <div className={`slot hold-slot${hud.holdLocked ? ' locked' : ''}`}>
              <PieceGrid type={hud.hold} />
            </div>
            {/* 라벨은 '아이템 보관'과 헷갈리지 않게 '맡긴 조각'으로 쓴다(§6.3의 용어 분리).
                잠김은 색이 아니라 이 텍스트로도 알린다(§12.8.1) */}
            <p className="slot-label">{hud.holdLocked ? '맡긴 조각 (잠김)' : '맡긴 조각'}</p>
          </section>
          <section className="panel">
            <h2>아이템 (1 2 3)</h2>
            <ul className="items">
              {Array.from({ length: ITEM_SLOTS }, (_, i) => {
                const it = hud.items[i];
                // 1번 칸이 비었고 이번 레벨에 아직 안 불렀으면 그 칸이 곧 '부르기' 버튼이다(§10.8).
                // 색이 아니라 글자가 바뀌는 것이 신호다
                const summon = !it && i === 0 && hud.canSummon;
                return (
                  <li key={i}>
                    <button
                      type="button"
                      className={it ? 'item' : summon ? 'item blank summon' : 'item blank'}
                      aria-label={
                        it
                          ? `아이템 ${i + 1}번 ${ITEMS[it].name} 사용`
                          : summon
                            ? '아이템 1번 긴막대 부르기'
                            : `아이템 ${i + 1}번 비어 있음`
                      }
                      onClick={() => go((a) => a.useItem(i as ItemSlot))}
                    >
                      <span className="key">{i + 1}</span>
                      <span className="icon" aria-hidden="true">
                        {it ? <ItemIcon item={it} /> : null}
                      </span>
                      <span className="name">
                        {it ? ITEMS[it].name : summon ? '부르기 (1)' : '비어 있음'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </aside>

        <div className="board-wrap panel">
          <canvas ref={canvasRef} tabIndex={-1} role="img" aria-label="테트리스 보드" />
          <div className="clip jump" ref={jumpRef} hidden aria-hidden="true">
            <video src="./icon/toshiri_jumping_alpha.webm" muted playsInline preload="auto" />
            <div className="badge">🐰</div>
          </div>
          <div className="clip carrot" ref={carrotRef} hidden aria-hidden="true">
            <video src="./icon/toshiri_carrot_alpha.webm" muted playsInline preload="auto" />
            <div className="badge">🐰</div>
          </div>
          <div className="overlay" hidden={hud.status === 'playing'}>
            {hud.status === 'paused' ? (
              <p>
                일시정지
                <br />
                <span>P 키로 계속</span>
              </p>
            ) : (
              <p>
                게임 오버
                <br />
                <span>R 키로 다시 하기</span>
              </p>
            )}
          </div>
          <div className="toast" ref={toastRef} hidden />
        </div>

        <aside className="side">
          <section className="panel">
            <h2>NEXT</h2>
            <div className="next">
              {hud.queue.map((t, i) => (
                <div className="slot" key={i}>
                  <PieceGrid type={t} />
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>

      <div className="touchpad">
        <button type="button" aria-label="왼쪽으로 이동" {...pressProps(-1)}>
          ←
        </button>
        <button type="button" aria-label="오른쪽으로 이동" {...pressProps(1)}>
          →
        </button>
        <button type="button" aria-label="회전" onClick={() => go((a) => a.rotate())}>
          ↻
        </button>
        <button
          type="button"
          aria-label="천천히 내리기"
          onPointerDown={(e) => {
            e.preventDefault();
            go((a) => a.softDrop(true));
          }}
          onPointerUp={() => go((a) => a.softDrop(false))}
          onPointerLeave={() => go((a) => a.softDrop(false))}
          onPointerCancel={() => go((a) => a.softDrop(false))}
        >
          ↓
        </button>
        <button type="button" aria-label="뚝 떨어뜨리기" onClick={() => go((a) => a.hardDrop())}>
          ⤓
        </button>
        <button type="button" aria-label="조각 맡기기" onClick={() => go((a) => a.hold())}>
          C
        </button>
      </div>

      <p className="help">
        ← → 이동 · ↑ 회전 · ↓ 천천히 · Space 뚝 떨어뜨리기 · C 조각 맡기기 · 1 2 3 아이템 · P 일시정지
        · R 다시 하기 · M 소리 끄기
      </p>

        <div className="sr-only" aria-live="polite" ref={politeRef} />
        <div className="sr-only" aria-live="assertive" ref={assertiveRef} />
      </div>
    </>
  );
}
