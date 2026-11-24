import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePoll, useServer } from './api';
import Chart from './Chart';
import type { Candle } from './data';
import { useMarket } from './hooks';
import { arrow, changeText, fmt, fmt2, kstTime, shares, signed, tone, usSession } from './lib';
import { usePortfolio } from './portfolio';
import SearchBox from './Search';

// 미국 종목 화면 (2026-11-24). 시세·차트·내 보유만. 주문은 아직 국내만 한다
type Us = {
  code: string;
  name: string;
  excd: string;
  exName: string;
  sector: string;
  price: number;
  prev: number;
  open: number;
  high: number;
  low: number;
  w52h: number;
  w52l: number;
  per: number;
  pbr: number;
  eps: number;
  capUsd: number;
  fx: number;
  priceKrw: number;
  tradable: boolean;
  at: number;
};
const PERIODS: [string, string][] = [
  ['D', '일'],
  ['W', '주'],
  ['M', '월'],
];
const usd = (n: number) => `$${fmt2(n)}`;
/** 달러 큰 금액: 조·억 달러 */
function usdBig(n: number) {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}조`;
  if (n >= 1e8) return `$${fmt(n / 1e8)}억`;
  return `$${fmt(n)}`;
}

export default function UsStockPage({ sym }: { sym: string }) {
  const { live } = useServer();
  const navigate = useNavigate();
  const { stocks } = useMarket();
  const sess = usSession();
  const moving = sess.code !== 'closed';
  const d = usePoll<Us>(live ? `/api/us/${encodeURIComponent(sym)}` : null, moving ? 5000 : 60_000, true);
  const [p, setP] = useState('D');
  const c = usePoll<{ candles: Candle[] }>(live ? `/api/us/${encodeURIComponent(sym)}/candles?period=${p}` : null, 60_000);
  const port = usePortfolio(stocks);
  const s = d.data;
  const candles = c.data?.candles ?? [];
  const today = useMemo(() => candles[candles.length - 1], [candles]);
  const go = (code: string) => navigate(`/stock/${code}`);

  if (!live)
    return (
      <div className="soon">
        <h1>{sym}</h1>
        <p>미국 종목은 서버(한투)에 연결됐을 때 볼 수 있습니다.</p>
      </div>
    );
  if (!s)
    return (
      <div className="stock">
        <SearchBox stocks={stocks} onGo={go} />
        <div className="soon">
          <h1>{sym}</h1>
          <p>{d.error ? `불러오지 못했습니다: ${d.error}` : '불러오는 중…'}</p>
        </div>
      </div>
    );

  const ch = s.price - s.prev;
  const pct = s.prev ? (ch / s.prev) * 100 : 0;
  const stats: [string, string, number][] = [
    ['전일', usd(s.prev), 0],
    ['시가', usd(s.open), s.open - s.prev],
    ['고가', usd(s.high), s.high - s.prev],
    ['저가', usd(s.low), s.low - s.prev],
    ['거래량', today ? shares(today.v) : '-', 0],
    ['시가총액', usdBig(s.capUsd), 0],
  ];
  const r = port.rows.find((x) => x.code === s.code);
  const info: [string, string][] = [
    ['거래소', s.exName],
    ['업종', s.sector || '-'],
    ['52주 최고', usd(s.w52h)],
    ['52주 최저', usd(s.w52l)],
    ['최고가 대비', s.w52h ? changeText(((s.price - s.w52h) / s.w52h) * 100) : '-'],
    ['PER', s.per ? `${s.per.toFixed(1)}배` : '-'],
    ['PBR', s.pbr ? `${s.pbr.toFixed(1)}배` : '-'],
    ['EPS', s.eps ? usd(s.eps) : '-'],
    ['원화 시총', s.fx ? `${fmt((s.capUsd * s.fx) / 1e12)}조원` : '-'],
    ['환율', s.fx ? `${fmt2(s.fx)}원` : '-'],
  ];

  return (
    <div className="stock us-stock">
      <section className="st-head" aria-label="종목 요약">
        <div className="st-title">
          <div className="st-name">
            <h1>{s.name}</h1>
            <span className="num sec">
              {s.code} · {s.exName}
              {s.sector ? ` · ${s.sector}` : ''}
            </span>
          </div>
          <div className={`st-price num ${tone(ch)}`}>
            <b>{usd(s.price)}</b>
            <span>
              {arrow(ch)} {signed(ch, fmt2)} ({changeText(pct).replace(/^[▲▼] /, '')})
            </span>
            <em className={`st-sess ${moving ? 'on' : ''}`}>{sess.label}</em>
          </div>
          <p className="us-krw num">약 {fmt(s.priceKrw || s.price * s.fx)}원</p>
        </div>
        <dl className="st-stats">
          {stats.map(([k, v, t]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className={`num ${tone(t)}`}>{v}</dd>
            </div>
          ))}
        </dl>
        <span className="grow" />
        <SearchBox stocks={stocks} onGo={go} />
      </section>

      <section className="panel-t st-chart" aria-label="차트">
        <div className="st-bar">
          <div className="seg sm" role="group" aria-label="차트 주기">
            {PERIODS.map(([k, l]) => (
              <button key={k} type="button" aria-pressed={p === k} onClick={() => setP(k)}>
                {l}
              </button>
            ))}
          </div>
          <span className="sub">미국 시간 기준 · 달러</span>
        </div>
        <Chart candles={candles} label={`${s.name} ${PERIODS.find(([k]) => k === p)![1]}봉 차트`} fmt={fmt2} />
      </section>

      <div className="st-bottom">
        <section className="panel-t" aria-labelledby="h-us-info">
          <h2 id="h-us-info">종목 정보</h2>
          <dl className="kv">
            {info.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd className="num">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="panel-t" aria-labelledby="h-us-mine">
          <h2 id="h-us-mine">내 보유</h2>
          {r ? (
            <dl className="kv">
              {(
                [
                  ['수량', `${fmt(r.qty)}주`, 0],
                  ['평균단가', `${fmt(r.avg)}원 (약 ${usd(s.fx ? r.avg / s.fx : 0)})`, 0],
                  ['평가금액', `${fmt(r.amt)}원`, 0],
                  ['평가손익', `${arrow(r.pnl)} ${signed(r.pnl)}원`, r.pnl],
                  ['수익률', changeText(r.profit), r.profit],
                  ['비중', `${r.weight.toFixed(1)}%`, 0],
                ] as [string, string, number][]
              ).map(([k, v, t]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd className={`num ${tone(t)}`}>{v}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="sub">이 종목은 갖고 있지 않습니다.</p>
          )}
          <p className="sub">미국 주식 주문은 아직 이 앱에서 하지 않습니다. 한투 앱에서 해 주세요.</p>
        </section>
      </div>
      <p className="st-foot">
        미국 {sess.label} · {kstTime(new Date(s.at * 1000))} 기준 · 한투 시세
      </p>
    </div>
  );
}
