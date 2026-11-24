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
/** scale: 이 %에서 가장 진하다 (오늘 등락률 3, 내 수익률 30) */
export function heatColor(pct: number, palette: Palette, scale = 3): { bg: string; ink: string } {
  const p = HEAT[palette];
  const t = Math.max(-1, Math.min(1, pct / scale));
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

// ---------- 장 상태 (토스처럼 프리·정규·애프터, 미국은 주간거래까지. 공휴일은 아직 반영 안 함) ----------
// 서버(market.py sessions)와 같은 규칙. 화면은 브라우저 시계로 바로 계산한다
export type Session = { code: 'pre' | 'regular' | 'after' | 'day' | 'closed'; label: string };
export type MarketStatus = {
  /** 국내 정규장 (규칙·주문 정정은 이때만) */
  open: boolean;
  /** 국내든 미국이든 가격이 움직이는 시간 */
  moving: boolean;
  kr: Session;
  us: Session;
  label: string;
};
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function clock(d: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  // 월=0 … 일=6 (파이썬 weekday 와 같게)
  return { wd: (WD.indexOf(get('weekday')) + 6) % 7, m: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}
export function krSession(d = new Date()): Session {
  const { wd, m } = clock(d, 'Asia/Seoul');
  if (wd >= 5) return { code: 'closed', label: '휴장' };
  if (m >= 480 && m < 530) return { code: 'pre', label: '프리마켓' };
  if (m >= 540 && m < 930) return { code: 'regular', label: '정규장' };
  if (m >= 940 && m < 1200) return { code: 'after', label: '애프터마켓' };
  return { code: 'closed', label: m < 540 ? '장 시작 전' : '장 마감' };
}
export function usSession(d = new Date()): Session {
  const { wd, m } = clock(d, 'America/New_York'); // 서머타임은 브라우저가 맞춘다
  if (wd < 5 && m >= 240 && m < 570) return { code: 'pre', label: '프리마켓' };
  if (wd < 5 && m >= 570 && m < 960) return { code: 'regular', label: '정규장' };
  if (wd < 5 && m >= 960 && m < 1200) return { code: 'after', label: '애프터마켓' };
  if ((m >= 1200 && [6, 0, 1, 2, 3].includes(wd)) || (m < 240 && wd < 5)) return { code: 'day', label: '주간거래' };
  return { code: 'closed', label: wd >= 5 ? '휴장' : '장 마감' };
}
export function marketStatus(d = new Date()): MarketStatus {
  const kr = krSession(d);
  const us = usSession(d);
  return { open: kr.code === 'regular', moving: kr.code !== 'closed' || us.code !== 'closed', kr, us, label: `국내 ${kr.label} · 미국 ${us.label}` };
}
export const kstTime = (d: Date) => d.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
/** "국내 애프터마켓 · 미국 주간거래 · 21:09:30 기준". 둘 다 닫혀 있으면 시각은 빼고 */
export const stampOf = (s: MarketStatus, at: Date) => (s.moving ? `${s.label} · ${kstTime(at)} 기준` : s.label);

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
