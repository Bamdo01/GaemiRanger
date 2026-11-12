import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { changeText, heatColor, squarify, type Theme } from './lib';

export type Tile = {
  id: string;
  group: string;
  size: number;
  pct: number; // 색을 정하는 값 (%)
  name: string;
  extra?: string; // 칸이 클 때만 보이는 셋째 줄
  tip: [string, string][];
};

const HEAD = 20;

export default function Heatmap({ tiles, theme, onPick, label }: { tiles: Tile[]; theme: Theme; onPick: (id: string) => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tip, setTip] = useState<{ x: number; y: number; t: Tile } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 처음 크기는 바로 잰다 (ResizeObserver 는 화면을 그릴 때까지 늦게 올 수 있음)
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    const { w, h } = size;
    if (!w || !h || !tiles.length) return { groups: [], cells: [] };
    const byGroup = new Map<string, Tile[]>();
    for (const t of tiles) byGroup.set(t.group, [...(byGroup.get(t.group) ?? []), t]);
    const total = tiles.reduce((a, t) => a + t.size, 0);
    const groups = [...byGroup.entries()]
      .map(([name, items]) => {
        const sum = items.reduce((a, t) => a + t.size, 0);
        return { name, items, sum, avg: items.reduce((a, t) => a + t.pct * t.size, 0) / sum, area: (sum / total) * w * h };
      })
      .sort((a, b) => b.sum - a.sum);
    const placed = squarify(groups, { x: 0, y: 0, w, h });
    const cells: (Tile & { x: number; y: number; w: number; h: number })[] = [];
    const heads: { name: string; avg: number; x: number; y: number; w: number; h: number; showHead: boolean }[] = [];
    for (const g of placed) {
      const showHead = g.h > 46 && g.w > 64;
      const inner = { x: g.x + 2, y: g.y + (showHead ? HEAD : 2), w: Math.max(0, g.w - 4), h: Math.max(0, g.h - (showHead ? HEAD + 2 : 4)) };
      const items = [...g.items].sort((a, b) => b.size - a.size).map((t) => ({ ...t, area: (t.size / g.sum) * inner.w * inner.h }));
      cells.push(...squarify(items, inner));
      heads.push({ name: g.name, avg: g.avg, x: g.x, y: g.y, w: g.w, h: g.h, showHead });
    }
    return { groups: heads, cells };
  }, [tiles, size]);

  const move = (e: React.MouseEvent, t: Tile) => {
    const r = ref.current!.getBoundingClientRect();
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, t });
  };

  return (
    <div className="heat" ref={ref} role="group" aria-label={label} onMouseLeave={() => setTip(null)}>
      {layout.groups.map((g) => (
        <div key={g.name} className="grp" style={{ left: g.x + 1, top: g.y + 1, width: g.w - 2, height: g.h - 2 }}>
          {g.showHead && (
            <div className="grp-head">
              <b>{g.name}</b> <span className={g.avg > 0 ? 'up' : g.avg < 0 ? 'dn' : ''}>{changeText(g.avg)}</span>
            </div>
          )}
        </div>
      ))}
      {layout.cells.map((c) => {
        const col = heatColor(c.pct, theme);
        const fs = Math.max(10, Math.min(30, c.w / (c.name.length * 0.95 + 1), c.h / 3.1));
        const showName = c.w > 36 && c.h > 22;
        return (
          <button
            key={c.id}
            type="button"
            className="tile"
            style={{ left: c.x + 1, top: c.y + 1, width: Math.max(0, c.w - 2), height: Math.max(0, c.h - 2), background: col.bg, color: col.ink }}
            onClick={() => onPick(c.id)}
            onMouseMove={(e) => move(e, c)}
            aria-label={`${c.name} ${changeText(c.pct)}`}
          >
            {showName && <span className="t-name" style={{ fontSize: fs }}>{c.name}</span>}
            {showName && c.h > 38 && <span className="t-pct" style={{ fontSize: Math.max(10, fs * 0.66) }}>{changeText(c.pct)}</span>}
            {showName && c.extra && c.h > 76 && c.w > 84 && <span className="t-extra" style={{ fontSize: Math.max(10, fs * 0.5) }}>{c.extra}</span>}
          </button>
        );
      })}
      {tip && (
        <div
          className="tip"
          style={{
            left: Math.min(tip.x + 14, size.w - 236),
            top: tip.y + 14 + 200 > size.h ? Math.max(4, tip.y - 210) : tip.y + 14,
          }}
        >
          <strong>{tip.t.name}</strong>
          <dl>
            {tip.t.tip.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

export function Legend({ theme }: { theme: Theme }) {
  const steps = [-3, -2, -1, 0, 1, 2, 3];
  return (
    <div className="legend" aria-label="색 범례">
      <span>▼ 하락</span>
      {steps.map((s) => {
        const c = heatColor(s, theme);
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
