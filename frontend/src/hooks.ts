import { useEffect, useMemo, useState } from 'react';
import { INDICES, STOCKS, tickOf, type Index, type Stock } from './data';
import { marketStatus, type MarketStatus, type Palette } from './lib';

const REFRESH_MS = 10_000; // P2: 장중 10초마다

/** 예시 시세. 장중에는 10초마다 조금씩 움직이고, 장 밖에서는 멈춘다. */
export function useMarket(): { status: MarketStatus; stocks: Stock[]; indices: Index[]; at: Date } {
  const [status, setStatus] = useState(marketStatus);
  const [stocks, setStocks] = useState(STOCKS);
  const [indices, setIndices] = useState(INDICES);
  const [at, setAt] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => {
      const s = marketStatus();
      setStatus(s);
      if (!s.open) return;
      setStocks((prev) => prev.map(jitterStock));
      setIndices((prev) => prev.map((i) => ({ ...i, value: Math.round(i.value * (1 + (Math.random() - 0.5) * 0.002) * 100) / 100 })));
      setAt(new Date());
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  return { status, stocks, indices, at };
}
function jitterStock(s: Stock): Stock {
  const raw = s.price * (1 + (Math.random() - 0.5) * 0.006);
  const t = tickOf(raw);
  const price = Math.min(s.prev * 1.3, Math.max(s.prev * 0.7, Math.round(raw / t) * t));
  return { ...s, price };
}

/** 고른 팔레트. 처음에는 시스템이 다크 모드면 밤하늘, 아니면 크림. */
export function usePalette(): [Palette, (p: Palette) => void] {
  const [palette, setPalette] = useState<Palette>(() => {
    try {
      const v = localStorage.getItem('gaemiranger.palette');
      if (v === 'cream' || v === 'white' || v === 'night') return v;
    } catch {
      /* 저장소를 못 쓰면 시스템 설정을 따른다 */
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'night' : 'cream';
  });
  useEffect(() => {
    document.documentElement.dataset.palette = palette;
    try {
      localStorage.setItem('gaemiranger.palette', palette);
    } catch {
      /* 무시 */
    }
  }, [palette]);
  return [palette, setPalette];
}


// ---------- 그룹 (M4): 한 종목은 한 그룹, 기본은 업종 ----------
export type Group = { id: string; name: string; sector?: string };
type GroupState = { groups: Group[]; assign: Record<string, string> };
const GKEY = 'gaemiranger.groups.v1';
const sectorId = (s: string) => `sector:${s}`;

function normalize(st: GroupState, held: { code: string; sector: string }[]): GroupState {
  const groups = [...st.groups];
  const assign: Record<string, string> = {};
  for (const h of held) {
    let gid = st.assign[h.code];
    if (!gid || !groups.some((g) => g.id === gid)) {
      gid = sectorId(h.sector);
      if (!groups.some((g) => g.id === gid)) groups.push({ id: gid, name: h.sector, sector: h.sector });
    }
    assign[h.code] = gid;
  }
  return { groups, assign };
}

/** 지금은 이 브라우저에만 저장한다. 백엔드를 만들면 서버 도구(/api/groups)로 옮긴다. */
export function useGroups(held: { code: string; sector: string }[]) {
  const [raw, setRaw] = useState<GroupState>(() => {
    try {
      const v = localStorage.getItem(GKEY);
      if (v) return JSON.parse(v) as GroupState;
    } catch {
      /* 무시 */
    }
    return { groups: [], assign: {} };
  });
  const st = useMemo(() => normalize(raw, held), [raw, held]);
  useEffect(() => {
    try {
      localStorage.setItem(GKEY, JSON.stringify(st));
    } catch {
      /* 무시 */
    }
  }, [st]);
  const sectorOf = (code: string) => held.find((h) => h.code === code)?.sector;
  return {
    groups: st.groups,
    assign: st.assign,
    count: (gid: string) => Object.values(st.assign).filter((g) => g === gid).length,
    /** 업종 그룹은 원래 그 업종 종목이 남아 있으면 못 지운다 (지워도 바로 다시 생기므로) */
    canRemove: (g: Group) => !g.sector || !Object.entries(st.assign).some(([c, gid]) => gid === g.id && sectorOf(c) === g.sector),
    create: (name: string) => setRaw({ ...st, groups: [...st.groups, { id: `g${Date.now()}`, name }] }),
    rename: (id: string, name: string) => setRaw({ ...st, groups: st.groups.map((g) => (g.id === id ? { ...g, name } : g)) }),
    remove: (id: string) => {
      const assign = Object.fromEntries(Object.entries(st.assign).filter(([, g]) => g !== id));
      setRaw({ groups: st.groups.filter((g) => g.id !== id), assign });
    },
    move: (code: string, gid: string) => setRaw({ ...st, assign: { ...st.assign, [code]: gid } }),
    reset: () => setRaw({ groups: [], assign: {} }),
  };
}
