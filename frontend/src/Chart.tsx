import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Candle } from './data';
import { fmt, shares } from './lib';

// 캔들 차트 (SVG). 위는 가격과 이동평균, 아래는 거래량. 오른쪽에 가격 눈금.
const PRICE_H = 340;
const VOL_H = 80;
const AXIS_W = 64;
const MAS: [number, string][] = [
  [5, 'var(--ma5)'],
  [20, 'var(--ma20)'],
  [60, 'var(--ma60)'],
];

export default function Chart({ candles, label }: { candles: Candle[]; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(el.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = Math.max(0, w - AXIS_W);
  // 한 봉에 7px 이상. 다 못 들어가면 최근 것부터
  const n = Math.max(1, Math.min(candles.length, Math.floor(W / 7)));
  const start = candles.length - n;
  const vis = candles.slice(start);

  const g = useMemo(() => {
    if (!W || !vis.length) return null;
    const ma = (m: number) => candles.map((_, i) => (i < m - 1 ? null : candles.slice(i - m + 1, i + 1).reduce((a, k) => a + k.c, 0) / m));
    const maAll = MAS.map(([m]) => ma(m));
    const maVis = maAll.map((a) => a.slice(start));
    const vals = [...vis.flatMap((k) => [k.h, k.l]), ...maVis.flat().filter((v): v is number => v !== null)];
    let hi = Math.max(...vals);
    let lo = Math.min(...vals);
    const pad = (hi - lo) * 0.06 || hi * 0.01;
    hi += pad;
    lo -= pad;
    const step = W / vis.length;
    const bw = Math.max(1, step * 0.64);
    const y = (v: number) => ((hi - v) / (hi - lo)) * PRICE_H;
    const vmax = Math.max(...vis.map((k) => k.v));
    const x = (i: number) => i * step + step / 2;
    const line = (arr: (number | null)[]) => arr.reduce<string>((d, v, i) => (v === null ? d : d + (d ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)), '');
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ y: t * PRICE_H, v: hi - t * (hi - lo) }));
    const dateIdx = [0, 0.2, 0.4, 0.6, 0.8].map((t) => Math.floor(t * (vis.length - 1)));
    return { step, bw, y, x, vmax, ticks, dateIdx, maLines: maVis.map(line), maVis };
  }, [W, vis, candles, start]);

  const last = vis[vis.length - 1];
  const hk = hover !== null ? vis[hover] : last;
  const hi = hover !== null ? hover : vis.length - 1;
  const prevC = hi > 0 ? vis[hi - 1].c : hk?.o;
  const chg = hk && prevC ? ((hk.c - prevC) / prevC) * 100 : 0;

  return (
    <div className="chart" ref={ref}>
      {hk && (
        <div className="chart-info num" aria-live="off">
          <span>{hk.t}</span>
          <span>시 {fmt(hk.o)}</span>
          <span>고 {fmt(hk.h)}</span>
          <span>저 {fmt(hk.l)}</span>
          <span className={chg > 0 ? 'up' : chg < 0 ? 'dn' : ''}>
            종 {fmt(hk.c)} ({chg > 0 ? '+' : ''}
            {chg.toFixed(2)}%)
          </span>
          <span>거래량 {shares(hk.v)}</span>
          {g &&
            MAS.map(([m, col], i) => {
              const v = g.maVis[i][hi];
              return (
                <span key={m} style={{ color: col }}>
                  MA{m} {v === null ? '-' : fmt(v)}
                </span>
              );
            })}
        </div>
      )}
      {!candles.length && <p className="sub">차트를 받는 중…</p>}
      {g && (
        <svg
          width={w}
          height={PRICE_H + VOL_H + 22}
          role="img"
          aria-label={label}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const i = Math.floor((e.clientX - r.left) / g.step);
            setHover(i >= 0 && i < vis.length ? i : null);
          }}
          onMouseLeave={() => setHover(null)}
        >
          {g.ticks.map((t) => (
            <g key={t.y}>
              <line x1={0} x2={W} y1={t.y} y2={t.y} className="grid" />
              <text x={W + 6} y={t.y} dy="0.35em" className="axis num">
                {fmt(t.v)}
              </text>
            </g>
          ))}
          <line x1={0} x2={W} y1={PRICE_H + 1} y2={PRICE_H + 1} className="sep" />
          {vis.map((k, i) => {
            const up = k.c >= k.o;
            const cx = g.x(i);
            const top = g.y(Math.max(k.o, k.c));
            const bh = Math.max(1, Math.abs(g.y(k.o) - g.y(k.c)));
            const vh = (k.v / g.vmax) * (VOL_H - 6);
            return (
              <g key={k.t} className={up ? 'c-up' : 'c-dn'}>
                <line x1={cx} x2={cx} y1={g.y(k.h)} y2={g.y(k.l)} />
                <rect x={cx - g.bw / 2} y={top} width={g.bw} height={bh} />
                <rect className="vol" x={cx - g.bw / 2} y={PRICE_H + VOL_H - vh} width={g.bw} height={vh} />
              </g>
            );
          })}
          {g.maLines.map((d, i) => (
            <path key={MAS[i][0]} d={d} fill="none" stroke={MAS[i][1]} strokeWidth={1.3} />
          ))}
          {last && (
            <g>
              <line x1={0} x2={W} y1={g.y(last.c)} y2={g.y(last.c)} className="last" />
              <rect x={W + 2} y={g.y(last.c) - 9} width={AXIS_W - 4} height={18} rx={3} className="last-tag" />
              <text x={W + 6} y={g.y(last.c)} dy="0.35em" className="last-text num">
                {fmt(last.c)}
              </text>
            </g>
          )}
          {hover !== null && <line x1={g.x(hover)} x2={g.x(hover)} y1={0} y2={PRICE_H + VOL_H} className="cross" />}
          {g.dateIdx.map((i) => (
            <text key={i} x={g.x(i)} y={PRICE_H + VOL_H + 16} className="axis num" textAnchor="middle">
              {vis[i].t.slice(2)}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}
