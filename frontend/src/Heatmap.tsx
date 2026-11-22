import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { changeText, heatColor, squarify, tone, type Palette } from './lib';

export type Tile = {
  id: string;
  /** 묶음 이름. 빈 문자열이면 묶지 않는다. */
  group: string;
  size: number;
  pct: number;
  name: string;
  held?: boolean;
  /** 칸이 크면 셋째 줄에 보여 줄 값 (예: 평가금액) */
  extra?: string;
  /** 등락률 줄 대신 보여 줄 글자 (예: 현금 칸) */
  label?: string;
  /** 이 칸의 바탕색 (주면 등락률 색 대신) */
  color?: string;
  /** 누르지 않는 칸 */
  static?: boolean;
  /** 방금 값이 바뀜 (잠깐 반짝임) */
  flash?: 'up' | 'dn';
  tip: [string, string][];
};

// 묶음 머리 높이, 묶음 안쪽 여백, 칸 사이 간격 (px)
const HEAD = 30;
const PAD = 6;
const GAP = 5;

type Props = { tiles: Tile[]; palette: Palette; label: string; onPick: (id: string) => void };

export default function Heatmap({ tiles, palette, label, onPick }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tip, setTip] = useState<{ t: Tile; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read(); // 백그라운드 탭에서는 ResizeObserver 가 늦게 불릴 수 있어서 바로 한 번 잰다
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const L = useMemo(() => layout(tiles, size.w, size.h), [tiles, size]);

  const showTip = (t: Tile, x: number, y: number) => setTip({ t, x, y });

  return (
    <div className="heat" ref={ref} role="group" aria-label={label} onMouseLeave={() => setTip(null)}>
      {L.groups.map((g) => (
        <div key={g.name} className="grp" style={{ left: g.x + 1, top: g.y + 1, width: Math.max(0, g.w - 2), height: Math.max(0, g.h - 2) }}>
          {g.show && (
            <div className="grp-head">
              <span>{g.name}</span> <b className={tone(g.avg)}>{changeText(g.avg)}</b>
            </div>
          )}
        </div>
      ))}
      {L.tiles.map((t) => {
        const w = Math.max(0, t.w - GAP);
        const h = Math.max(0, t.h - GAP);
        const c = t.color ? { bg: t.color, ink: 'var(--ink)' } : heatColor(t.pct, palette);
        const fs = Math.max(11, Math.min(28, w / (t.name.length * 0.95 + 1.2), h / 3.4));
        const ps = Math.max(11, fs * 0.62);
        const showName = w > 40 && h > 24;
        const showPct = showName && h > 42;
        const textH = (showName ? fs * 1.15 : 0) + (showPct ? ps * 1.2 + 2 : 0) + 14;
        const showExtra = !!t.extra && showPct && h > textH + ps * 1.3 && w > 70;
        return (
          <button
            key={t.id}
            type="button"
            className={`tile${t.flash ? ` flash-${t.flash}` : ''}`}
            aria-label={`${t.name} ${t.label ?? changeText(t.pct)}`}
            style={{ left: t.x + GAP / 2, top: t.y + GAP / 2, width: w, height: h, background: c.bg, color: c.ink, cursor: t.static ? 'default' : undefined }}
            onClick={() => !t.static && onPick(t.id)}
            onMouseMove={(e) => showTip(t, e.clientX, e.clientY)}
            onFocus={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              showTip(t, r.left + r.width / 2, r.top + r.height / 2);
            }}
            onBlur={() => setTip(null)}
          >
            {showName && (
              <span className="t-name" style={{ fontSize: Math.round(fs) }}>
                {t.name}
              </span>
            )}
            {showPct && (
              <span className="t-pct" style={{ fontSize: Math.round(ps) }}>
                {t.label ?? changeText(t.pct)}
              </span>
            )}
            {showExtra && (
              <span className="t-extra" style={{ fontSize: Math.round(ps * 0.92) }}>
                {t.extra}
              </span>
            )}
            {t.held && w > 80 && h > textH + 22 && <span className="mine">내 종목</span>}
          </button>
        );
      })}
      {tip && <Tip {...tip} />}
    </div>
  );
}

function Tip({ t, x, y }: { t: Tile; x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + 16, top: y + 16 });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    let left = x + 16;
    let top = y + 16;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 16;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 16;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);
  return (
    <div className="tip" ref={ref} style={pos} role="tooltip">
      <strong>{t.name}</strong>
      <dl>
        {t.tip.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={v.startsWith('▲') ? 'up' : v.startsWith('▼') ? 'dn' : undefined}>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

type Placed = Tile & { x: number; y: number; w: number; h: number };
type PlacedGroup = { name: string; avg: number; show: boolean; x: number; y: number; w: number; h: number };

function layout(tiles: Tile[], W: number, H: number): { groups: PlacedGroup[]; tiles: Placed[] } {
  const out = { groups: [] as PlacedGroup[], tiles: [] as Placed[] };
  if (!W || !H || !tiles.length) return out;
  const total = tiles.reduce((a, t) => a + t.size, 0);
  const by = new Map<string, Tile[]>();
  for (const t of tiles) by.set(t.group, [...(by.get(t.group) ?? []), t]);
  const G = [...by]
    .map(([name, its]) => {
      const sum = its.reduce((a, t) => a + t.size, 0);
      return { name, its, sum, avg: its.reduce((a, t) => a + t.pct * t.size, 0) / sum, area: (sum / total) * W * H };
    })
    .sort((a, b) => b.sum - a.sum);
  for (const g of squarify(G, { x: 0, y: 0, w: W, h: H })) {
    const sorted = [...g.its].sort((a, b) => b.size - a.size);
    if (!g.name) {
      out.tiles.push(...squarify(sorted.map((t) => ({ ...t, area: (t.size / g.sum) * g.w * g.h })), g));
      continue;
    }
    const show = g.h > 56 && g.w > 80;
    const top = show ? HEAD : PAD;
    const inner = { x: g.x + PAD, y: g.y + top, w: Math.max(0, g.w - PAD * 2), h: Math.max(0, g.h - top - PAD) };
    out.groups.push({ name: g.name, avg: g.avg, show, x: g.x, y: g.y, w: g.w, h: g.h });
    out.tiles.push(...squarify(sorted.map((t) => ({ ...t, area: (t.size / g.sum) * inner.w * inner.h })), inner));
  }
  return out;
}

export function Legend({ palette }: { palette: Palette }) {
  return (
    <div className="legend" aria-label="범례">
      <span>▼ 하락</span>
      {[-3, -2, -1, 0, 1, 2, 3].map((s) => {
        const c = heatColor(s, palette);
        return (
          <span key={s} className="lg-step" style={{ background: c.bg, color: c.ink }}>
            {s === 0 ? '0' : `${s > 0 ? '+' : ''}${s}%`}
          </span>
        );
      })}
      <span>상승 ▲</span>
    </div>
  );
}
