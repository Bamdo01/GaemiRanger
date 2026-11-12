import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { changeText, heatColor, squarify, type Theme } from './lib';

// 3D 히트맵 (주식 도시). 바닥 넓이 = size, 지붕 색 = pct, 건물 높이 = height(0~1).
export type Tile = {
  id: string;
  group: string;
  size: number;
  pct: number;
  height: number;
  name: string;
  extra?: string;
  tip: [string, string][];
};

type Pt = [number, number];
type Bld = Tile & { x: number; y: number; w: number; d: number; faces: Pt[][]; roof: Pt; col: { bg: string; ink: string }; hz: number };

const GROUND: Record<Theme, { ground: string; plate: string; label: string; labelInk: string; edge: string }> = {
  light: { ground: '#cfd5dd', plate: '#e9edf2', label: 'rgba(23,23,27,.86)', labelInk: '#ffffff', edge: 'rgba(23,23,27,.14)' },
  dark: { ground: '#1b1d23', plate: '#262931', label: 'rgba(242,242,244,.9)', labelInk: '#0d0d10', edge: 'rgba(0,0,0,.35)' },
};
const HMAX = 30; // 가장 높은 건물 (바닥 한 변이 100일 때)
const HMIN = 1.2; // 높이 값이 0인 건물도 이만큼은 선다

export default function City({ tiles, theme, onPick, label }: { tiles: Tile[]; theme: Theme; onPick: (id: string) => void; label: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ x: number; y: number; id: string } | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 배치: 업종(그룹) 판 → 그 안에 건물. 화면이 넓으면 도시도 옆으로 길게.
  const scene = useMemo(() => {
    const { w: W, h: H } = size;
    if (!W || !H || !tiles.length) return null;
    const DD = 100;
    const WD = 100 * Math.max(1, Math.min(2.4, (W / H) * 0.85));
    const byGroup = new Map<string, Tile[]>();
    for (const t of tiles) byGroup.set(t.group, [...(byGroup.get(t.group) ?? []), t]);
    const total = tiles.reduce((a, t) => a + t.size, 0);
    const groups = [...byGroup.entries()]
      .map(([name, items]) => {
        const sum = items.reduce((a, t) => a + t.size, 0);
        return { name, items, sum, avg: items.reduce((a, t) => a + t.pct * t.size, 0) / sum, area: (sum / total) * WD * DD };
      })
      .sort((a, b) => b.sum - a.sum);
    const plates: { name: string; avg: number; x: number; y: number; w: number; d: number }[] = [];
    const blds: Omit<Bld, 'faces' | 'roof' | 'col' | 'hz'>[] = [];
    for (const g of squarify(groups, { x: 0, y: 0, w: WD, h: DD })) {
      const ins = 1.4;
      const p = { x: g.x + ins, y: g.y + ins, w: Math.max(0.1, g.w - ins * 2), d: Math.max(0.1, g.h - ins * 2) };
      plates.push({ name: g.name, avg: g.avg, ...p });
      const items = [...g.items].sort((a, b) => b.size - a.size).map((t) => ({ ...t, area: (t.size / g.sum) * p.w * p.d }));
      for (const b of squarify(items, { x: p.x, y: p.y, w: p.w, h: p.d })) {
        const gap = 0.45;
        blds.push({ ...b, x: b.x + gap, y: b.y + gap, w: Math.max(0.15, b.w - gap * 2), d: Math.max(0.15, b.h - gap * 2) });
      }
    }
    // 아이소메트릭 투영
    const c = 0.866, si = 0.5;
    const isoW = (WD + DD) * c, isoH = (WD + DD) * si + HMAX;
    const s = Math.min((W - 24) / isoW, (H - 36) / isoH);
    const ox = W / 2 - ((WD - DD) / 2) * c * s;
    const oy = (H - isoH * s) / 2 + HMAX * s + 4;
    const P = (x: number, y: number, z: number): Pt => [ox + (x - y) * c * s, oy + (x + y) * si * s - z * s];
    // 뒤에서 앞으로 그린다
    blds.sort((a, b) => a.x + a.w / 2 + a.y + a.d / 2 - (b.x + b.w / 2 + b.y + b.d / 2));
    const built: Bld[] = blds.map((b) => {
      const hz = HMIN + Math.max(0, Math.min(1, b.height)) * (HMAX - HMIN);
      const { x, y, w, d } = b;
      const right = [P(x + w, y, 0), P(x + w, y + d, 0), P(x + w, y + d, hz), P(x + w, y, hz)];
      const front = [P(x, y + d, 0), P(x + w, y + d, 0), P(x + w, y + d, hz), P(x, y + d, hz)];
      const top = [P(x, y, hz), P(x + w, y, hz), P(x + w, y + d, hz), P(x, y + d, hz)];
      return { ...b, hz, faces: [right, front, top], roof: P(x + w / 2, y + d / 2, hz), col: heatColor(b.pct, theme) };
    });
    return { P, s, WD, DD, plates, built };
  }, [tiles, size, theme]);

  // 그리기
  useEffect(() => {
    const el = cv.current;
    if (!el || !scene) return;
    const { w: W, h: H } = size;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(W * dpr);
    el.height = Math.round(H * dpr);
    const g = el.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const pal = GROUND[theme];
    const { P, s, WD, DD } = scene;
    const poly = (pts: Pt[], fill: string, stroke?: string, lw = 1) => {
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      if (stroke) {
        g.strokeStyle = stroke;
        g.lineWidth = lw;
        g.stroke();
      }
    };
    poly([P(-1.5, -1.5, 0), P(WD + 1.5, -1.5, 0), P(WD + 1.5, DD + 1.5, 0), P(-1.5, DD + 1.5, 0)], pal.ground);
    for (const p of scene.plates) poly([P(p.x, p.y, 0), P(p.x + p.w, p.y, 0), P(p.x + p.w, p.y + p.d, 0), P(p.x, p.y + p.d, 0)], pal.plate);

    for (const b of scene.built) {
      const [r, f, t] = b.faces;
      const rgb = b.col.bg.match(/\d+/g)!.map(Number);
      const sh = (k: number) => `rgb(${rgb.map((v) => Math.round(v * k)).join(',')})`;
      poly(r, sh(0.8), pal.edge);
      poly(f, sh(0.66), pal.edge);
      const hot = hover?.id === b.id;
      poly(t, b.col.bg, hot ? (theme === 'dark' ? '#ffffff' : '#17171b') : pal.edge, hot ? 2.5 : 1);
      // 지붕 글자
      const roofW = (b.w + b.d) * 0.866 * s;
      if (roofW > 62) {
        const fs = Math.max(10, Math.min(20, roofW / (b.name.length * 1.3 + 1.2)));
        g.fillStyle = b.col.ink;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.font = `800 ${fs.toFixed(0)}px Pretendard, 'Malgun Gothic', sans-serif`;
        g.fillText(b.name, b.roof[0], b.roof[1] - fs * 0.38);
        g.font = `700 ${Math.max(10, fs * 0.74).toFixed(0)}px Pretendard, 'Malgun Gothic', sans-serif`;
        g.fillText(changeText(b.pct), b.roof[0], b.roof[1] + fs * 0.6);
      }
    }
    // 업종 이름표 (판 앞쪽 모서리)
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 12px Pretendard, 'Malgun Gothic', sans-serif`;
    for (const p of scene.plates) {
      if ((p.w + p.d) * 0.866 * s < 140) continue;
      const q = P(p.x + p.w, p.y + p.d, 0);
      const text = `${p.name} ${changeText(p.avg)}`;
      const m = g.measureText(text).width + 14;
      g.fillStyle = pal.label;
      g.beginPath();
      if (g.roundRect) g.roundRect(q[0] - m / 2, q[1] + 3, m, 20, 10);
      else g.rect(q[0] - m / 2, q[1] + 3, m, 20);
      g.fill();
      g.fillStyle = pal.labelInk;
      g.fillText(text, q[0], q[1] + 13);
    }
  }, [scene, size, theme, hover?.id]);

  const pick = (e: React.MouseEvent): Bld | null => {
    if (!scene) return null;
    const r = cv.current!.getBoundingClientRect();
    const pt: Pt = [e.clientX - r.left, e.clientY - r.top];
    for (let i = scene.built.length - 1; i >= 0; i--) if (scene.built[i].faces.some((f) => inside(pt, f))) return scene.built[i];
    return null;
  };
  const hovered = hover && scene?.built.find((b) => b.id === hover.id);

  return (
    <div className="heat city" ref={wrap} onMouseLeave={() => setHover(null)}>
      <canvas
        ref={cv}
        role="img"
        aria-label={label}
        style={{ cursor: hover ? 'pointer' : 'default' }}
        onMouseMove={(e) => {
          const b = pick(e);
          const r = cv.current!.getBoundingClientRect();
          setHover(b ? { x: e.clientX - r.left, y: e.clientY - r.top, id: b.id } : null);
        }}
        onClick={(e) => {
          const b = pick(e);
          if (b) onPick(b.id);
        }}
      />
      {/* 화면 읽기 프로그램과 키보드용 목록 */}
      <ul className="sr">
        {tiles.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => onPick(t.id)}>
              {t.name} {changeText(t.pct)}
            </button>
          </li>
        ))}
      </ul>
      {hover && hovered && (
        <div className="tip" style={{ left: Math.min(hover.x + 14, size.w - 236), top: hover.y + 214 > size.h ? Math.max(4, hover.y - 210) : hover.y + 14 }}>
          <strong>{hovered.name}</strong>
          <dl>
            {hovered.tip.map(([k, v]) => (
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

function inside([x, y]: Pt, poly: Pt[]) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

export function Legend({ theme, height }: { theme: Theme; height: string }) {
  const steps = [-3, -2, -1, 0, 1, 2, 3];
  return (
    <div className="legend" aria-label="범례">
      <span>지붕 색 ▼ 하락</span>
      {steps.map((s) => {
        const c = heatColor(s, theme);
        return (
          <span key={s} className="lg-step" style={{ background: c.bg, color: c.ink }}>
            {s === 0 ? '0' : `${s > 0 ? '+' : ''}${s}%`}
          </span>
        );
      })}
      <span>상승 ▲</span>
      <span className="lg-sep">높이 = {height}</span>
    </div>
  );
}
