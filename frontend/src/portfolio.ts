import { useMemo } from 'react';
import { CASH, HOLDINGS, STOCK_BY_CODE, type Stock } from './data';

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
};

// 보유 종목의 원래 업종 (그룹 기본값). 바뀌지 않으므로 한 번만 만든다.
export const HELD = HOLDINGS.map((h) => ({ code: h.code, sector: STOCK_BY_CODE.get(h.code)!.sector }));

/** 지금 시세로 계산한 내 자산 */
export function usePortfolio(stocks: Stock[]) {
  return useMemo(() => {
    const by = new Map(stocks.map((s) => [s.code, s]));
    const base = HOLDINGS.map((h) => {
      const s = by.get(h.code)!;
      const amt = h.qty * s.price;
      return {
        ...h,
        s,
        amt,
        pnl: amt - h.qty * h.avg,
        profit: ((s.price - h.avg) / h.avg) * 100,
        today: ((s.price - s.prev) / s.prev) * 100,
        todayPnl: h.qty * (s.price - s.prev),
      };
    });
    const stockValue = base.reduce((a, r) => a + r.amt, 0);
    const cost = base.reduce((a, r) => a + r.qty * r.avg, 0);
    const rows: Row[] = base.map((r) => ({ ...r, weight: stockValue ? (r.amt / stockValue) * 100 : 0 }));
    const todayPnl = rows.reduce((a, r) => a + r.todayPnl, 0);
    return {
      rows,
      cash: CASH,
      stockValue,
      cost,
      total: stockValue + CASH,
      pnl: stockValue - cost,
      pnlPct: cost ? ((stockValue - cost) / cost) * 100 : 0,
      todayPnl,
      todayPct: stockValue - todayPnl ? (todayPnl / (stockValue - todayPnl)) * 100 : 0,
    };
  }, [stocks]);
}
export type Portfolio = ReturnType<typeof usePortfolio>;
