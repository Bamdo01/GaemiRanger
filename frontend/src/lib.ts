/** 색은 밤하늘 하나 (2026-11-22 사용자). 화면 부품이 팔레트를 받던 자리는 그대로 둔다 */
export type Palette = 'night';

export const fmt = (n: number) => Math.round(n).toLocaleString('ko-KR');
export const fmt2 = (n: number) => n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const arrow = (v: number) => (v > 0 ? '▲' : v < 0 ? '▼' : '');
export const signed = (v: number, f: (n: number) => string = fmt) => (v > 0 ? '+' : v < 0 ? '-' : '') + f(Math.abs(v));
export const signPct = (v: number, d = 2) => (v > 0 ? '+' : v < 0 ? '-' : '') + Math.abs(v).toFixed(d) + '%';
/** "▲ +1.28%" 처럼 화살표와 부호를 항상 붙인다 (색만으로 구분하지 않게) */
export const changeText = (v: number, d = 2) => `${arrow(v)} ${signPct(v, d)}`.trim();
export const tone = (v: number) => (v > 0 ? 'up' : v < 0 ? 'dn' : 'flat');

// ---------- 히트맵 색: 상승 초록, 하락 빨강, ±3%에서 가장 진함 ----------
type RGB = [number, number, number];
const HEAT: Record<Palette, { base: RGB; up: RGB; dn: RGB; dark: string; light: string }> = {
  night: { base: [46, 56, 82], up: [44, 172, 100], dn: [214, 76, 82], dark: '#0f1424', light: '#ffffff' },
};
export function heatColor(pct: number, palette: Palette): { bg: string; ink: string } {
  const p = HEAT[palette];
  const t = Math.max(-1, Math.min(1, pct / 3));
  const a = Math.pow(Math.abs(t), 0.75);
  const to = t >= 0 ? p.up : p.dn;
  const c = p.base.map((b, i) => Math.round(b + (to[i] - b) * a)) as RGB;
  return { bg: `rgb(${c.join(',')})`, ink: luminance(c) > 0.2 ? p.dark : p.light };
}
function luminance(c: RGB) {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

// ---------- 장 상태 (한국 시간 기준, 공휴일은 아직 반영 안 함) ----------
export type MarketStatus = { open: boolean; label: string };
export function marketStatus(d = new Date()): MarketStatus {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wd = get('weekday');
  const mins = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  if (wd === 'Sat' || wd === 'Sun') return { open: false, label: '휴장' };
  if (mins < 9 * 60) return { open: false, label: '장 시작 전' };
  if (mins >= 15 * 60 + 30) return { open: false, label: '장 마감' };
  return { open: true, label: '장중' };
}
export const kstTime = (d: Date) => d.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });

// ---------- squarified treemap ----------
export type Rect = { x: number; y: number; w: number; h: number };
export function squarify<T extends { area: number }>(items: T[], r: Rect): (T & Rect)[] {
  const out: (T & Rect)[] = [];
  let rest = items.filter((i) => i.area > 0);
  let R = { ...r };
  const worst = (row: T[], side: number) => {
    const s = row.reduce((a, b) => a + b.area, 0);
    const mx = Math.max(...row.map((x) => x.area));
    const mn = Math.min(...row.map((x) => x.area));
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  while (rest.length) {
    const side = Math.min(R.w, R.h);
    const row = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]], side) <= worst(row, side)) row.push(rest[i++]);
    rest = rest.slice(row.length);
    const s = row.reduce((a, b) => a + b.area, 0);
    if (R.w >= R.h) {
      const cw = R.h ? s / R.h : 0;
      let cy = R.y;
      for (const it of row) {
        const rh = cw ? it.area / cw : 0;
        out.push({ ...it, x: R.x, y: cy, w: cw, h: rh });
        cy += rh;
      }
      R = { x: R.x + cw, y: R.y, w: R.w - cw, h: R.h };
    } else {
      const rh = R.w ? s / R.w : 0;
      let cx = R.x;
      for (const it of row) {
        const rw = rh ? it.area / rh : 0;
        out.push({ ...it, x: cx, y: R.y, w: rw, h: rh });
        cx += rw;
      }
      R = { x: R.x, y: R.y + rh, w: R.w, h: R.h - rh };
    }
  }
  return out;
}

/** 금액을 조·억 단위로: 1.23조원, 4,560억원, 9,800만원 */
export function won(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(n >= 1e13 ? 1 : 2)}조원`;
  if (n >= 1e8) return `${fmt(n / 1e8)}억원`;
  if (n >= 1e4) return `${fmt(n / 1e4)}만원`;
  return `${fmt(n)}원`;
}
/** 주식 수를 억·만 단위로: 1.2억주, 1,234만주 */
export const shares = (n: number) => (n >= 1e8 ? `${(n / 1e8).toFixed(1)}억주` : n >= 1e4 ? `${fmt(n / 1e4)}만주` : `${fmt(n)}주`);
