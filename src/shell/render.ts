// 보드 캔버스 렌더러 — 2D Context 1개. 규칙 판정은 하지 않는다(§3).
import { COLS, ROWS, VISIBLE_ROWS, PIECE_TYPES, FX_LEVELUP_MS, ghostY, pieceCells } from '../core/tetris';
import type { GameState, PieceType } from '../core/types';

// --- 치수 (전부 관례값, §12.3) ---
export const CELL = 30; // (관례값) 보드 셀 한 변
export const PREVIEW_CELL = 24; // S1 하한 "미리보기 블록 한 변 최소 24px"
export const BOARD_W = COLS * CELL; // 300
export const BOARD_H = VISIBLE_ROWS * CELL; // 600
export const TOP = ROWS - VISIBLE_ROWS; // 20 — 셸은 y ∈ [20,39]만 그린다 (§2.2)

// --- 팔레트 (전 hex 관례값, §12.5. 대비비가 실측된 값이니 임의로 바꾸지 마라) ---
// §12.14.2 밝은 톤 개정. 대비 수치는 하이라이트를 씌운 최악 합성 픽셀 기준(vs 보드 크림)
export const PIECE_COLORS: Record<PieceType, string> = {
  I: '#0E86B8', // 3.17
  J: '#2A4FC4', // 4.92
  L: '#E04E00', // 3.19
  O: '#FFD400', // 채우기 1.34 — §12.14.7 3:1 예외(사용자가 대가를 알고 택함). 경계는 아래 O 전용 테두리가 진다
  S: '#2E8B36', // 3.28
  Z: '#C1123A', // 4.88
  T: '#7B3FC4', // 4.52
};
export const PALETTE = {
  boardBg: '#FFF6EA',
  grid: '#EADFCE',
  cellBorder: '#5A4632',
  oBorder: '#3A2B1F', // O 전용 진갈색 테두리 — vs 보드 12.70 / vs 노랑 9.49 (§12.14.7)
  text: '#3A2B1F',
  pink: '#A32F5B', // 강조
  popup: '#B34A00',
};
const STAR_COLORS = ['#E04E00', '#A32F5B', '#2A4FC4']; // (관례값) §11 — 밝은 배경에서 보이도록 진한 3색

// --- 연출 상태 (셸 소유. 규칙은 코어의 fxLevelUpMs가 쥔다) ---
export interface FxState {
  levelUp: { t0: number; level: number } | null;
  popups: { t0: number; text: string; y: number }[];
}
export const newFx = (): FxState => ({ levelUp: null, popups: [] });

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

function cellPath(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, s, s, r);
}

export const O_BORDER_W = 2.5; // (관례값) O만 굵은 테두리 §12.14.7

/** 30px 셀 1개를 §12.7 절차대로 그린 타일. 색마다 1회만 만든다. */
function makeTile(color: string, dpr: number, border: string, bw: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = CELL * dpr;
  c.height = CELL * dpr;
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  // 1. 바탕
  g.fillStyle = color;
  cellPath(g, 0, 0, CELL, 4);
  g.fill();
  g.save();
  g.clip();
  // 2. 상단 하이라이트 25% (알파 0.05 — §12.14.3. 밝은 배경에선 하이라이트가 대비를 깎는다)
  g.fillStyle = 'rgba(255,255,255,0.05)';
  g.fillRect(0, 0, CELL, CELL * 0.25);
  // 3. 하단 그림자 20% (알파 0.14 — §12.14.3. 밝은 배경에선 그림자가 대비를 올린다)
  g.fillStyle = 'rgba(0,0,0,0.14)';
  g.fillRect(0, CELL * 0.8, CELL, CELL * 0.2);
  g.restore();
  // 4~5. 스터드 2×2, 지름 9px
  for (const [sx, sy] of [
    [9, 9],
    [21, 9],
    [9, 21],
    [21, 21],
  ]) {
    g.beginPath();
    g.arc(sx, sy, 4.5, Math.PI, 0);
    g.fillStyle = 'rgba(255,255,255,0.08)'; // 스터드 위반원 (§12.14.3으로 0.28에서 내림)
    g.fill();
    g.beginPath();
    g.arc(sx, sy, 4.5, 0, Math.PI);
    g.fillStyle = 'rgba(0,0,0,0.14)'; // 스터드 아래반원 (§12.14.3으로 0.08에서 올림)
    g.fill();
  }
  // 6. 테두리 (O만 §12.14.7의 진갈색·2.5px)
  g.strokeStyle = border;
  g.lineWidth = bw;
  cellPath(g, bw / 2, bw / 2, CELL - bw, 4 - bw / 2);
  g.stroke();
  return c;
}

/** 보드 배경 + 격자. 1회만 그려두고 매 프레임 drawImage 1회로 복사한다(§12.2). */
function makeBackground(dpr: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = BOARD_W * dpr;
  c.height = BOARD_H * dpr;
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  g.fillStyle = PALETTE.boardBg;
  g.fillRect(0, 0, BOARD_W, BOARD_H);
  g.strokeStyle = PALETTE.grid;
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 1; x < COLS; x++) {
    g.moveTo(x * CELL + 0.5, 0);
    g.lineTo(x * CELL + 0.5, BOARD_H);
  }
  for (let y = 1; y < VISIBLE_ROWS; y++) {
    g.moveTo(0, y * CELL + 0.5);
    g.lineTo(BOARD_W, y * CELL + 0.5);
  }
  g.stroke();
  return c;
}

function drawStars(ctx: CanvasRenderingContext2D, el: number) {
  const n = 14; // (관례값) §11
  const spread = easeOutCubic(Math.min(el, 700) / 700) * 150;
  const spin = (Math.min(el, 700) / 700) * Math.PI;
  const alpha = el < 600 ? 1 : 1 - (el - 600) / 300;
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    const size = 6 + (i % 5) * 2; // 6~14px
    const x = 150 + Math.cos(ang) * spread;
    const y = 300 + Math.sin(ang) * spread;
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.translate(x, y);
    ctx.rotate(spin);
    ctx.fillStyle = STAR_COLORS[i % STAR_COLORS.length];
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const r = k % 2 === 0 ? size : size * 0.38;
      const a = (k / 8) * Math.PI * 2;
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

// §12.14.9 떨어지는 조각 식별 — 이중 외곽선(흰 3px 바깥 + 검정 2px 안쪽, 경계 대비 18.24)
const OUTLINE_OUTER = '#FFFFFF';
const OUTLINE_INNER = '#1A1410';
const SPARK_COLOR = '#B34A00'; // (관례값) 보드 대비 5.04

/** 조각 전체 실루엣의 바깥 변만 모은다(셀 사이 경계는 넣지 않는다). */
function silhouette(cells: [number, number][], ox: number, oy: number) {
  const set = new Set(cells.map(([dx, dy]) => `${dx},${dy}`));
  const edge = new Path2D();
  const region = new Path2D();
  for (const [dx, dy] of cells) {
    const x = ox + dx * CELL;
    const y = oy + dy * CELL;
    region.rect(x, y, CELL, CELL);
    if (!set.has(`${dx},${dy - 1}`)) {
      edge.moveTo(x, y);
      edge.lineTo(x + CELL, y);
    }
    if (!set.has(`${dx},${dy + 1}`)) {
      edge.moveTo(x, y + CELL);
      edge.lineTo(x + CELL, y + CELL);
    }
    if (!set.has(`${dx - 1},${dy}`)) {
      edge.moveTo(x, y);
      edge.lineTo(x, y + CELL);
    }
    if (!set.has(`${dx + 1},${dy}`)) {
      edge.moveTo(x + CELL, y);
      edge.lineTo(x + CELL, y + CELL);
    }
  }
  return { edge, region };
}

/** 조각 위쪽 반짝이 3개 — 1200ms 주기로 떠오르며 페이드 (전 항목 관례값). reduced-motion에서만 꺼진다 */
function drawSparkles(ctx: CanvasRenderingContext2D, left: number, width: number, top: number, now: number) {
  const cycle = Math.floor(now / 1200);
  const t = (now % 1200) / 1200;
  for (let i = 0; i < 3; i++) {
    const h = Math.sin(cycle * 12.9898 + i * 78.233) * 43758.5453;
    const fx = h - Math.floor(h);
    const x = left + 4 + fx * Math.max(4, width - 8);
    const y = top - 6 - t * 12;
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = SPARK_COLOR;
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-2, -2, 4, 4); // 한 변 4px
    ctx.restore();
  }
}

export function createRenderer(canvas: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(BOARD_W * dpr);
  canvas.height = Math.round(BOARD_H * dpr);
  canvas.style.width = `${BOARD_W}px`;
  canvas.style.height = `${BOARD_H}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  const bg = makeBackground(dpr);
  const tiles = {} as Record<PieceType, HTMLCanvasElement>;
  for (const t of PIECE_TYPES)
    tiles[t] = makeTile(
      PIECE_COLORS[t],
      dpr,
      t === 'O' ? PALETTE.oBorder : PALETTE.cellBorder,
      t === 'O' ? O_BORDER_W : 1.5,
    );

  return function draw(state: GameState, fx: FxState, now: number, reduced: boolean) {
    ctx.drawImage(bg, 0, 0, BOARD_W, BOARD_H);

    // 쌓인 블록
    for (let y = TOP; y < ROWS; y++) {
      const row = state.board[y];
      for (let x = 0; x < COLS; x++) {
        const t = row[x];
        if (t) ctx.drawImage(tiles[t], x * CELL, (y - TOP) * CELL, CELL, CELL);
      }
    }

    const a = state.active;
    if (a) {
      // 고스트 — 외곽선 2px, 알파 0.55 (관례값) §12.6. reduced-motion에서도 끄지 않는다
      const gy = ghostY(state);
      if (gy !== null) {
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = PIECE_COLORS[a.type];
        ctx.lineWidth = 2;
        for (const [dx, dy] of pieceCells(a.type, a.rotation)) {
          const y = gy + dy;
          if (y < TOP) continue;
          cellPath(ctx, (a.x + dx) * CELL + 2, (y - TOP) * CELL + 2, CELL - 4, 4);
          ctx.stroke();
        }
        ctx.restore();
      }
      // 현재 조각 — 타일 → 실루엣 클립 → 검정(10px) → 흰색(6px) 순서 (§12.14.9.1).
      // 두 선 모두 클립 안이라 조각 칸 밖으로는 한 픽셀도 나가지 않는다.
      // 클립 안에서 굵은 검정 위에 흰색을 덮으므로 가장자리부터 흰 3px → 검정 2px → 조각 색이 된다.
      const vis = pieceCells(a.type, a.rotation).filter(([, dy]) => a.y + dy >= TOP) as [
        number,
        number,
      ][];
      if (vis.length) {
        const { edge, region } = silhouette(vis, a.x * CELL, (a.y - TOP) * CELL);
        for (const [dx, dy] of vis) {
          ctx.drawImage(tiles[a.type], (a.x + dx) * CELL, (a.y + dy - TOP) * CELL, CELL, CELL);
        }
        ctx.save();
        ctx.clip(region);
        ctx.lineCap = 'square';
        ctx.strokeStyle = OUTLINE_INNER;
        ctx.lineWidth = 10; // 클립되어 안쪽 [0,5]px 띠
        ctx.stroke(edge);
        ctx.strokeStyle = OUTLINE_OUTER;
        ctx.lineWidth = 6; // 안쪽 [0,3]px — 검정의 바깥쪽을 덮는다
        ctx.stroke(edge);
        ctx.restore();
        if (!reduced) {
          const xs = vis.map(([dx]) => dx);
          const left = (a.x + Math.min(...xs)) * CELL;
          const right = (a.x + Math.max(...xs) + 1) * CELL;
          const top = (a.y + Math.min(...vis.map(([, dy]) => dy)) - TOP) * CELL;
          drawSparkles(ctx, left, right - left, top, now);
        }
      }
    }

    // 점수 팝업 (관례값: 600ms, 40px 상승 + 페이드. reduced면 제자리 정적)
    for (let i = fx.popups.length - 1; i >= 0; i--) {
      const p = fx.popups[i];
      const el = now - p.t0;
      if (el >= 600) {
        fx.popups.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = reduced ? 1 : 1 - el / 600;
      ctx.fillStyle = PALETTE.popup;
      ctx.font = 'bold 28px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(p.text, BOARD_W / 2, p.y + CELL - (reduced ? 0 : (el / 600) * 40));
      ctx.restore();
    }

    // 레벨업 연출 (관례값 §11)
    if (fx.levelUp) {
      const el = now - fx.levelUp.t0;
      if (el >= FX_LEVELUP_MS) {
        fx.levelUp = null;
      } else {
        if (!reduced) drawStars(ctx, el);
        let scale = 1;
        let alpha = 1;
        if (!reduced) {
          if (el < 180) scale = 1 + 0.6 * easeOutCubic(el / 180);
          else if (el < 700) scale = 1.6;
          else {
            scale = 1.6 - 0.6 * ((el - 700) / 200);
            alpha = 1 - (el - 700) / 200;
          }
        }
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(BOARD_W / 2, BOARD_H / 2);
        ctx.scale(scale, scale);
        ctx.font = 'bold 40px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 6;
        ctx.strokeStyle = PALETTE.pink;
        ctx.strokeText(`LEVEL ${fx.levelUp.level}`, 0, 0);
        ctx.fillStyle = PALETTE.text;
        ctx.fillText(`LEVEL ${fx.levelUp.level}`, 0, 0);
        ctx.restore();
      }
    }
  };
}
