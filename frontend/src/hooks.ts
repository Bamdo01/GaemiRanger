import { useEffect, useState } from 'react';
import { usePoll, useServer } from './api';
import { CASH, HOLDINGS, INDICES, STOCKS, tickOf, type Account, type Holding, type Index, type Stock } from './data';
import { marketStatus, type MarketStatus, type Palette } from './lib';

const REFRESH_MS = 10_000; // P2: 장중 10초마다
const CAP = new Map(STOCKS.map((s) => [s.code, s.cap]));

/** 시세. 서버에 로그인돼 있고 한투 키가 있으면 서버(한투 모의) 값, 아니면 예시 값 (장중 10초마다 조금씩 움직임). */
export function useMarket(): { status: MarketStatus; stocks: Stock[]; indices: Index[]; at: Date; live: boolean; error: string } {
  const { live } = useServer();
  const [status, setStatus] = useState(marketStatus);
  const [stocks, setStocks] = useState(STOCKS);
  const [indices, setIndices] = useState(INDICES);
  const [at, setAt] = useState(() => new Date());
  const srv = usePoll<{ stocks: Stock[]; indices: Index[]; at: number | null }>(live ? '/api/market' : null, REFRESH_MS, true);
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
      // 시가총액을 서버가 아직 못 받은 종목은 예시 데이터의 시가총액으로 칸 크기를 먼저 잡는다
      stocks: (d?.stocks ?? []).map((s) => (s.cap ? s : { ...s, cap: CAP.get(s.code) ?? 1 })),
      indices: d?.indices ?? [],
      at: d?.at ? new Date(d.at * 1000) : new Date(),
      live: true,
      error: srv.error,
    };
  }
  return { status, stocks, indices, at, live: false, error: '' };
}

type PortfolioRes = { holdings: Holding[]; cash: number; accounts: Account[]; realized: number; dividends: number; fx: number; fxSource: string; usesUsd: boolean; fxDefault: boolean };
export type HoldingsState = PortfolioRes & { live: boolean; loaded: boolean; error: string };

/** 내 자산 = 한투(연동) + 수기 계좌. account 는 all 또는 계좌 id. 서버가 없으면 예시 */
export function useHoldings(account = 'all'): HoldingsState {
  const { live } = useServer();
  const srv = usePoll<PortfolioRes>(live ? `/api/portfolio?account=${encodeURIComponent(account)}` : null, REFRESH_MS, true);
  if (live)
    return {
      holdings: srv.data?.holdings ?? [],
      cash: srv.data?.cash ?? 0,
      accounts: srv.data?.accounts ?? [],
      realized: srv.data?.realized ?? 0,
      dividends: srv.data?.dividends ?? 0,
      fx: srv.data?.fx ?? 0,
      fxSource: srv.data?.fxSource ?? '',
      usesUsd: !!srv.data?.usesUsd,
      fxDefault: !!srv.data?.fxDefault,
      live: true,
      loaded: !!srv.data,
      error: srv.error,
    };
  return { holdings: HOLDINGS, cash: CASH, accounts: [], realized: 0, dividends: 0, fx: 0, fxSource: '', usesUsd: false, fxDefault: false, live: false, loaded: true, error: '' };
}
function jitterStock(s: Stock): Stock {
  const raw = s.price * (1 + (Math.random() - 0.5) * 0.006);
  const t = tickOf(raw);
  const price = Math.min(s.prev * 1.3, Math.max(s.prev * 0.7, Math.round(raw / t) * t));
  return { ...s, price };
}

/** 색은 밤하늘 하나뿐 */
export function usePalette(): Palette {
  return 'night';
}

