import { useEffect, useState } from 'react';
import { usePoll, useServer } from './api';
import { CASH, HOLDINGS, INDICES, STOCKS, tickOf, type Holding, type Index, type Stock } from './data';
import { marketStatus, type MarketStatus, type Palette } from './lib';

const REFRESH_MS = 10_000; // P2: 장중 10초마다

/** 시세. 서버에 로그인돼 있고 한투 키가 있으면 서버(한투 모의) 값, 아니면 예시 값 (장중 10초마다 조금씩 움직임). */
export function useMarket(): { status: MarketStatus; stocks: Stock[]; indices: Index[]; at: Date; live: boolean; error: string } {
  const { live } = useServer();
  const [status, setStatus] = useState(marketStatus);
  const [stocks, setStocks] = useState(STOCKS);
  const [indices, setIndices] = useState(INDICES);
  const [at, setAt] = useState(() => new Date());
  const srv = usePoll<{ stocks: Stock[]; indices: Index[]; at: number | null }>(live ? '/api/market' : null, REFRESH_MS);
  useEffect(() => {
    const id = setInterval(() => {
      const s = marketStatus();
      setStatus(s);
      if (live || !s.open) return;
      setStocks((prev) => prev.map(jitterStock));
      setIndices((prev) => prev.map((i) => ({ ...i, value: Math.round(i.value * (1 + (Math.random() - 0.5) * 0.002) * 100) / 100 })));
      setAt(new Date());
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [live]);
  if (live) {
    const d = srv.data;
    return {
      status,
      stocks: d?.stocks ?? [],
      indices: d?.indices ?? [],
      at: d?.at ? new Date(d.at * 1000) : new Date(),
      live: true,
      error: srv.error,
    };
  }
  return { status, stocks, indices, at, live: false, error: '' };
}

/** 내 잔고. 서버면 한투 모의계좌 잔고, 아니면 예시 */
export function useHoldings(): { holdings: Holding[]; cash: number; live: boolean; loaded: boolean; error: string } {
  const { live } = useServer();
  const srv = usePoll<{ holdings: Holding[]; cash: number }>(live ? '/api/portfolio' : null, REFRESH_MS);
  if (live) return { holdings: srv.data?.holdings ?? [], cash: srv.data?.cash ?? 0, live: true, loaded: !!srv.data, error: srv.error };
  return { holdings: HOLDINGS, cash: CASH, live: false, loaded: true, error: '' };
}
function jitterStock(s: Stock): Stock {
  const raw = s.price * (1 + (Math.random() - 0.5) * 0.006);
  const t = tickOf(raw);
  const price = Math.min(s.prev * 1.3, Math.max(s.prev * 0.7, Math.round(raw / t) * t));
  return { ...s, price };
}

/** 팔레트는 밤하늘로 고정 (2026-11-22 사용자: 바꾸지 못하게). 크림·화이트 색 정의는 styles.css 에 남겨 둠 */
export function usePalette(): Palette {
  useEffect(() => {
    document.documentElement.dataset.palette = 'night';
  }, []);
  return 'night';
}

