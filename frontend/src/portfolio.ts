import { useMemo } from 'react';
import type { Stock } from './data';
import { useHoldings } from './hooks';
import { signPct } from './lib';

export type Row = {
  code: string;
  qty: number;
  avg: number;
  s: Stock;
  /** 평가금액 */
  amt: number;
  /** 평가손익 (원) */
  pnl: number;
  /** 내 수익률 (평균단가 대비 %) */
  profit: number;
  /** 오늘 등락률 % */
  today: number;
  /** 오늘 손익 (원) */
  todayPnl: number;
  /** 주식 중 비중 % */
  weight: number;
  /** 매도가능수량 */
  sellable: number;
  /** kr 국내주식, us 해외주식, coin 코인, etc 기타 */
  asset: string;
  accounts: { id: string; name: string; qty: number }[];
  currency: string;
  rawPrice: number;
  manualPrice: boolean;
};

/** 수량 글자: 코인·해외는 소수까지, 단위는 주/개 */
export const qtyText = (r: { qty: number; asset: string }) =>
  r.asset === 'etc' ? '-' : `${r.qty.toLocaleString('ko-KR', { maximumFractionDigits: 8 })}${r.asset === 'coin' ? '개' : r.asset === 'gold' ? 'g' : '주'}`;

/** 지금 시세로 계산한 내 자산 */
export function usePortfolio(stocks: Stock[], account = 'all') {
  const { holdings, cash, loaded, error, accounts, realized, dividends, fx, fxSource, usesUsd, fxDefault } = useHoldings(account);
  return useMemo(() => {
    const by = new Map(stocks.map((s) => [s.code, s]));
    const base = holdings.map((h) => {
      // 시장 50종목에 없는 보유 종목은 잔고에 온 값으로
      const kr = (h.asset ?? 'kr') === 'kr';
      const s: Stock = (kr ? by.get(h.code) : undefined) ?? { code: h.code, name: h.name ?? h.code, sector: h.sector ?? '기타', cap: 0, prev: h.prev ?? h.price ?? h.avg, price: h.price ?? h.avg };
      const amt = h.qty * s.price;
      return {
        code: h.code,
        qty: h.qty,
        avg: h.avg,
        sellable: h.sellable ?? h.qty,
        asset: h.asset ?? 'kr',
        accounts: h.accounts ?? [],
        currency: h.currency ?? 'KRW',
        rawPrice: h.rawPrice ?? s.price,
        manualPrice: !!h.manualPrice,
        s,
        amt,
        pnl: amt - h.qty * h.avg,
        profit: h.avg ? ((s.price - h.avg) / h.avg) * 100 : 0,
        today: s.prev ? ((s.price - s.prev) / s.prev) * 100 : 0,
        todayPnl: h.qty * (s.price - s.prev),
      };
    });
    const stockValue = base.reduce((a, r) => a + r.amt, 0);
    const cost = base.reduce((a, r) => a + r.qty * r.avg, 0);
    const rows: Row[] = base.map((r) => ({ ...r, weight: stockValue ? (r.amt / stockValue) * 100 : 0 }));
    const todayPnl = rows.reduce((a, r) => a + r.todayPnl, 0);
    return {
      rows,
      loaded,
      error,
      accounts,
      realized,
      dividends,
      fx,
      fxSource,
      usesUsd,
      fxDefault,
      cash,
      stockValue,
      cost,
      total: stockValue + cash,
      pnl: stockValue - cost,
      pnlPct: cost ? ((stockValue - cost) / cost) * 100 : 0,
      todayPnl,
      todayPct: stockValue - todayPnl ? (todayPnl / (stockValue - todayPnl)) * 100 : 0,
    };
  }, [stocks, holdings, cash, loaded, error, accounts, realized, dividends, fx, fxSource, usesUsd, fxDefault]);
}
export type Portfolio = ReturnType<typeof usePortfolio>;

/* ---------- 점검: AI 없이 계산 ---------- */
export function checksOf(port: Portfolio, kospiPct: number) {
  const top = [...port.rows].sort((a, b) => b.amt - a.amt)[0];
  const sectors = new Map<string, number>();
  port.rows.forEach((r) => sectors.set(r.s.sector, (sectors.get(r.s.sector) ?? 0) + r.amt));
  const [topSector, topSectorAmt] = [...sectors].sort((a, b) => b[1] - a[1])[0];
  const losers = port.rows.filter((r) => r.profit < 0).sort((a, b) => a.profit - b.profit);
  const topPct = (top.amt / port.total) * 100;
  const sectorPct = (topSectorAmt / port.total) * 100;
  const cashPct = (port.cash / port.total) * 100;
  const vs = port.todayPct - kospiPct;
  return {
    facts: { n: port.rows.length, top, topPct, topSector, sectorPct, cashPct, losers, vs, kospiPct, todayPct: port.todayPct },
    list: [
      { label: '가장 큰 종목', value: `${top.s.name} ${topPct.toFixed(1)}%`, warn: topPct > 25, why: '총자산 대비, 25% 넘으면 표시' },
      { label: '가장 큰 업종', value: `${topSector} ${sectorPct.toFixed(1)}%`, warn: sectorPct > 40, why: '총자산 대비, 40% 넘으면 표시' },
      { label: '현금', value: `${cashPct.toFixed(1)}%`, warn: cashPct < 5, why: '5% 아래면 표시' },
      { label: '손실 종목', value: losers.length ? losers.map((r) => `${r.s.name} ${signPct(r.profit)}`).join(', ') : '없음', warn: losers.length > 0, why: '평균단가 대비' },
      { label: '오늘 코스피 대비', value: `${vs >= 0 ? '+' : ''}${vs.toFixed(2)}%p`, warn: vs < 0, why: '내 주식 오늘 등락률 - 코스피 등락률' },
    ],
  };
}
export type Facts = ReturnType<typeof checksOf>['facts'];

