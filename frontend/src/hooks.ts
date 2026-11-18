import { useEffect, useState } from 'react';
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

