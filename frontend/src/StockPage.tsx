import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { post, usePoll } from './api';
import Chart from './Chart';
import { HOLDINGS, STOCKS, groupCandles, priceLimits, sampleBook, sampleDaily, sampleTrade, tickOf, type Candle, type Stock } from './data';
import { useMarket } from './hooks';
import { arrow, changeText, fmt, kstTime, shares, signed, tone, won } from './lib';
import { usePortfolio } from './portfolio';

// 종목 페이지 (2026-11-18): UI 시안 A안 "프로 터미널" 배치. 관심종목 | 차트 | 호가 | 주문, 아래 종목 정보·내 보유.
const LAST_KEY = 'gaemiranger.lastStock';
const WATCH_KEY = 'gaemiranger.watch';
const ORDER_LIMIT = 3_000_000; // 1회 주문 한도 (설정 C1 전 임시값)

function load<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
}
function save(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* 무시 */
  }
}

/** /stock → 마지막에 본 종목 */
export function StockHome() {
  const code = load<string>(LAST_KEY, '005930');
  return <Navigate to={`/stock/${STOCKS.some((s) => s.code === code) ? code : '005930'}`} replace />;
}

export default function StockPage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const { stocks, status, at, live } = useMarket();
  // 주문은 한투 계좌로만 나가므로 현금·보유 수량은 한투 계좌 것만
  const port = usePortfolio(stocks, 'kis');
  const detail = usePoll<Stock>(live && /^\d{6}$/.test(code) ? `/api/stock/${code}` : null, 5000);
  // 서버 응답 전에는 시장 화면에서 받아 둔 시세로 먼저 그린다 (한투 호출은 초당 1건이라 기다리지 않게)
  const s = (live ? detail.data : undefined) ?? stocks.find((x) => x.code === code);
  const [watch, setWatch] = useState<string[]>(() => load(WATCH_KEY, HOLDINGS.map((h) => h.code)));
  useEffect(() => save(WATCH_KEY, watch), [watch]);
  useEffect(() => {
    if (s) save(LAST_KEY, s.code);
  }, [s]);

  if (!s)
    return (
      <div className="soon">
        <h1>{code}</h1>
        <p>{live ? (detail.error ? `불러오지 못했습니다: ${detail.error}` : '불러오는 중…') : '예시 데이터에 없는 종목입니다. 지금은 코스피 시가총액 상위 50종목만 있습니다.'}</p>
      </div>
    );

  const watched = watch.includes(s.code);
  const go = (c: string) => navigate(`/stock/${c}`);

  return (
    <div className="stock">
      <StockHead s={s} live={live} watched={watched} onWatch={() => setWatch(watched ? watch.filter((c) => c !== s.code) : [...watch, s.code])} onGo={go} stocks={stocks} />
      <div className="st-grid">
        <WatchList stocks={stocks} watch={watch} held={port.rows.map((r) => r.code)} cur={s.code} onGo={go} />
        <ChartPanel s={s} live={live} />
        <OrderArea s={s} live={live} cash={port.cash} heldQty={port.rows.find((r) => r.code === s.code)?.sellable ?? 0} />
      </div>
      <div className="st-bottom">
        <Info s={s} live={live} />
        <MyHolding s={s} port={port} />
      </div>
      <p className="st-foot">
        {status.open ? `${kstTime(at)} 기준` : status.label} · {live ? '한투 모의투자 계좌 · 주문은 모의로 실제 접수됩니다' : '예시 데이터 (차트·호가·주문 모두 예시)'}
      </p>
    </div>
  );
}

/* ---------- 머리 ---------- */
function StockHead({ s, live, watched, onWatch, onGo, stocks }: { s: Stock; live: boolean; watched: boolean; onWatch: () => void; onGo: (c: string) => void; stocks: Stock[] }) {
  const d = s.price - s.prev;
  const daily = useMemo(() => (live ? [] : sampleDaily(s)), [s, live]);
  const today = live ? { o: s.open ?? 0, h: s.high ?? 0, l: s.low ?? 0 } : daily[daily.length - 1];
  const tr = live ? { vol: [s.vol ?? 0], val: [s.val ?? 0] } : sampleTrade(s);
  const [q, setQ] = useState('');
  const hits = q.trim() ? stocks.filter((x) => x.name.includes(q.trim()) || x.code.startsWith(q.trim())).slice(0, 8) : [];
  const stats: [string, string, number][] = [
    ['전일', fmt(s.prev), 0],
    ['시가', fmt(today.o), today.o - s.prev],
    ['고가', fmt(today.h), today.h - s.prev],
    ['저가', fmt(today.l), today.l - s.prev],
    ['거래량', shares(tr.vol[0]), 0],
    ['거래대금', won(tr.val[0]), 0],
  ];
  return (
    <section className="st-head" aria-label="종목 요약">
      <div className="st-title">
        <div className="st-name">
          <h1>{s.name}</h1>
          <span className="num sec">{s.code} · 코스피 · {s.sector}</span>
          <button type="button" className={`star ${watched ? 'on' : ''}`} aria-pressed={watched} onClick={onWatch} title={watched ? '관심종목에서 빼기' : '관심종목에 추가'}>
            {watched ? '★ 관심' : '☆ 관심'}
          </button>
        </div>
        <div className={`st-price num ${tone(d)}`}>
          <b>{fmt(s.price)}</b>
          <span>
            {arrow(d)} {signed(d)} ({changeText((d / s.prev) * 100).replace(/^[▲▼] /, '')})
          </span>
        </div>
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
      <div className="st-search">
        <label htmlFor="st-q" className="sr">
          종목 검색
        </label>
        <input
          id="st-q"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hits[0]) {
              onGo(hits[0].code);
              setQ('');
            }
          }}
          placeholder="종목명 또는 코드"
          autoComplete="off"
        />
        {hits.length > 0 && (
          <ul className="st-hits" role="listbox" aria-label="검색 결과">
            {hits.map((h) => (
              <li key={h.code}>
                <button
                  type="button"
                  onClick={() => {
                    onGo(h.code);
                    setQ('');
                  }}
                >
                  <span>{h.name}</span>
                  <small className="num">{h.code}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ---------- 관심종목 ---------- */
function WatchList({ stocks, watch, held, cur, onGo }: { stocks: Stock[]; watch: string[]; held: string[]; cur: string; onGo: (c: string) => void }) {
  const [tab, setTab] = useState<'watch' | 'held'>('watch');
  const codes = tab === 'watch' ? watch : held;
  const list = codes.map((c) => stocks.find((s) => s.code === c)).filter((s): s is Stock => !!s);
  return (
    <section className="panel-t st-watch" aria-label="관심종목">
      <div className="seg sm" role="group" aria-label="목록">
        <button type="button" aria-pressed={tab === 'watch'} onClick={() => setTab('watch')}>
          관심 {watch.length}
        </button>
        <button type="button" aria-pressed={tab === 'held'} onClick={() => setTab('held')}>
          보유 {held.length}
        </button>
      </div>
      <div className="wl-head">
        <span>종목</span>
        <span>현재가</span>
        <span>등락률</span>
      </div>
      {list.length === 0 && <p className="sub pad">{tab === 'watch' ? '☆ 관심을 눌러 추가하세요' : '보유 종목이 없습니다'}</p>}
      <ul className="wl">
        {list.map((s) => {
          const r = ((s.price - s.prev) / s.prev) * 100;
          return (
            <li key={s.code}>
              <button type="button" className={s.code === cur ? 'on' : undefined} aria-current={s.code === cur ? 'page' : undefined} onClick={() => onGo(s.code)}>
                <span className="wl-name">
                  {s.name}
                  <small className="num">{s.code}</small>
                </span>
                <span className={`num ${tone(r)}`}>{fmt(s.price)}</span>
                <span className={`num ${tone(r)}`}>{changeText(r).replace(/^[▲▼] /, '')}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ---------- 차트 ---------- */
const PERIODS: [string, string, number][] = [
  ['d', '일', 1],
  ['w', '주', 5],
  ['m', '월', 21],
];
function ChartPanel({ s, live }: { s: Stock; live: boolean }) {
  const [p, setP] = useState('d');
  const daily = useMemo(() => (live ? [] : sampleDaily(s)), [s, live]);
  const size = PERIODS.find(([k]) => k === p)![2];
  const srv = usePoll<{ candles: Candle[] }>(live ? `/api/stock/${s.code}/candles?period=${p.toUpperCase()}` : null, 60_000);
  const sample = useMemo(() => (size === 1 ? daily : groupCandles(daily, size)), [daily, size]);
  const candles = live ? srv.data?.candles ?? [] : sample;
  return (
    <section className="panel-t st-chart" aria-label="차트">
      <div className="st-bar">
        <div className="seg sm" role="group" aria-label="차트 주기">
          {PERIODS.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={p === k} onClick={() => setP(k)}>
              {l}
            </button>
          ))}
        </div>
        <span className="sub">분봉은 한투 연결 후</span>
      </div>
      <Chart candles={candles} label={`${s.name} ${PERIODS.find(([k]) => k === p)![1]}봉 차트`} />
    </section>
  );
}

/* ---------- 호가 + 주문 ---------- */
function OrderArea({ s, live, cash, heldQty }: { s: Stock; live: boolean; cash: number; heldQty: number }) {
  const [price, setPrice] = useState(s.price);
  useEffect(() => setPrice(s.price), [s.code]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Book s={s} live={live} onPick={setPrice} picked={price} />
      <OrderForm s={s} live={live} cash={cash} price={price} setPrice={setPrice} heldQty={heldQty} />
    </>
  );
}

function Book({ s, live, onPick, picked }: { s: Stock; live: boolean; onPick: (p: number) => void; picked: number }) {
  const srv = usePoll<{ asks: { p: number; q: number }[]; bids: { p: number; q: number }[] }>(live ? `/api/stock/${s.code}/book` : null, 3000);
  const { asks, bids } = live ? srv.data ?? { asks: [], bids: [] } : sampleBook(s);
  const max = Math.max(1, ...asks.map((a) => a.q), ...bids.map((b) => b.q));
  const sumA = asks.reduce((a, x) => a + x.q, 0);
  const sumB = bids.reduce((a, x) => a + x.q, 0);
  const row = (side: 'ask' | 'bid', x: { p: number; q: number }) => {
    const r = ((x.p - s.prev) / s.prev) * 100;
    return (
      <li key={side + x.p} className={side}>
        <span className="bq num">
          {side === 'ask' && (
            <>
              <i style={{ width: `${(x.q / max) * 100}%` }} />
              {fmt(x.q)}
            </>
          )}
        </span>
        <button type="button" className={`bp num ${tone(x.p - s.prev)} ${x.p === s.price ? 'cur' : ''} ${x.p === picked ? 'picked' : ''}`} onClick={() => onPick(x.p)} title={`${fmt(x.p)}원을 주문 가격으로`}>
          {fmt(x.p)}
          <small>{(r > 0 ? '+' : '') + r.toFixed(2)}%</small>
        </button>
        <span className="bq num">
          {side === 'bid' && (
            <>
              <i style={{ width: `${(x.q / max) * 100}%` }} />
              {fmt(x.q)}
            </>
          )}
        </span>
      </li>
    );
  };
  return (
    <section className="panel-t st-book" aria-label="호가">
      <div className="st-bar">
        <h2>호가</h2>
        <span className="sub">누르면 주문 가격으로</span>
      </div>
      <div className="bk-head">
        <span>매도잔량</span>
        <span>호가</span>
        <span>매수잔량</span>
      </div>
      <ul className="bk">
        {asks.map((a) => row('ask', a))}
        {bids.map((b) => row('bid', b))}
      </ul>
      <div className="bk-sum num">
        <span>{fmt(sumA)}</span>
        <span className="sub">잔량 합계</span>
        <span>{fmt(sumB)}</span>
      </div>
    </section>
  );
}

function OrderForm({ s, live, cash, price, setPrice, heldQty }: { s: Stock; live: boolean; cash: number; price: number; setPrice: (p: number) => void; heldQty: number }) {
  const [sending, setSending] = useState(false);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [kind, setKind] = useState<'limit' | 'market'>('limit');
  const [qty, setQty] = useState(1);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState('');
  const lim = s.upper && s.lower ? { upper: s.upper, lower: s.lower } : priceLimits(s.prev);
  const p = kind === 'market' ? s.price : price;
  const CASH = cash;
  const amount = p * qty;
  const maxQty = side === 'buy' ? Math.floor(Math.min(CASH, ORDER_LIMIT) / p) : heldQty;
  // 주문 검사 (O4)
  const problem =
    qty <= 0
      ? '수량을 1주 이상 넣어 주세요'
      : kind === 'limit' && p % tickOf(p) !== 0
        ? `호가 단위(${fmt(tickOf(p))}원)에 맞지 않습니다`
        : kind === 'limit' && (p > lim.upper || p < lim.lower)
          ? `상한가 ${fmt(lim.upper)} ~ 하한가 ${fmt(lim.lower)} 사이만 됩니다`
          : side === 'buy' && amount > CASH
            ? '주문가능금액이 모자랍니다'
            : side === 'sell' && qty > heldQty
              ? `매도가능수량은 ${fmt(heldQty)}주입니다`
              : amount > ORDER_LIMIT
                ? `1회 주문 한도 ${won(ORDER_LIMIT)}를 넘습니다`
                : '';
  const stepPrice = (dir: 1 | -1) => setPrice(Math.max(lim.lower, Math.min(lim.upper, dir > 0 ? p + tickOf(p) : p - tickOf(p - 1))));
  const sideName = side === 'buy' ? '매수' : '매도';

  return (
    <section className="panel-t st-order" aria-label="주문">
      <div className={`seg sm order-side ${side}`} role="group" aria-label="매수 매도">
        <button type="button" aria-pressed={side === 'buy'} onClick={() => setSide('buy')}>
          매수
        </button>
        <button type="button" aria-pressed={side === 'sell'} onClick={() => setSide('sell')}>
          매도
        </button>
      </div>
      <div className="seg sm" role="group" aria-label="주문 유형">
        <button type="button" aria-pressed={kind === 'limit'} onClick={() => setKind('limit')}>
          지정가
        </button>
        <button type="button" aria-pressed={kind === 'market'} onClick={() => setKind('market')}>
          시장가
        </button>
      </div>
      <div className="fld">
        <label htmlFor="o-price">가격 (원)</label>
        <div className="row">
          <button type="button" className="btn step" aria-label="한 호가 내리기" disabled={kind === 'market'} onClick={() => stepPrice(-1)}>
            −
          </button>
          <input
            id="o-price"
            className="num"
            inputMode="numeric"
            disabled={kind === 'market'}
            value={kind === 'market' ? '시장가' : fmt(price)}
            onChange={(e) => setPrice(Number(e.target.value.replace(/[^0-9]/g, '')) || 0)}
          />
          <button type="button" className="btn step" aria-label="한 호가 올리기" disabled={kind === 'market'} onClick={() => stepPrice(1)}>
            +
          </button>
        </div>
      </div>
      <div className="fld">
        <label htmlFor="o-qty">수량 (주)</label>
        <input id="o-qty" className="num" inputMode="numeric" value={fmt(qty)} onChange={(e) => setQty(Number(e.target.value.replace(/[^0-9]/g, '')) || 0)} />
        <div className="qty-btns">
          {[10, 25, 50, 100].map((r) => (
            <button key={r} type="button" className="btn sm" onClick={() => setQty(Math.max(0, Math.floor((maxQty * r) / 100)))}>
              {r === 100 ? '최대' : `${r}%`}
            </button>
          ))}
        </div>
      </div>
      <dl className="o-sum">
        <div>
          <dt>{side === 'buy' ? '주문가능금액' : '매도가능수량'}</dt>
          <dd className="num">{side === 'buy' ? `${fmt(CASH)}원` : `${fmt(heldQty)}주`}</dd>
        </div>
        <div>
          <dt>최대 {sideName}가능</dt>
          <dd className="num">{fmt(maxQty)}주</dd>
        </div>
        <div className="total">
          <dt>주문금액</dt>
          <dd className="num">{fmt(amount)}원</dd>
        </div>
      </dl>
      {problem && (
        <p className="o-warn" role="alert">
          {problem}
        </p>
      )}
      <button type="button" className={`o-go ${side}`} disabled={!!problem} onClick={() => setConfirm(true)}>
        {sideName} 주문
      </button>
      {done && (
        <p className="o-done" role="status">
          {done}
        </p>
      )}
      <p className="sub">1회 주문 한도 {won(ORDER_LIMIT)} · 모의투자{live ? ' · 서버가 한 번 더 검사합니다' : ' · 지금은 예시라 주문이 나가지 않습니다'}</p>

      {confirm && (
        <div className="modal-back" onClick={() => setConfirm(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="cf-t" onClick={(e) => e.stopPropagation()}>
            <h2 id="cf-t">{sideName} 주문 확인</h2>
            <dl>
              <div>
                <dt>종목</dt>
                <dd>
                  {s.name} <small className="num">{s.code}</small>
                </dd>
              </div>
              <div>
                <dt>가격</dt>
                <dd className="num">{kind === 'market' ? `시장가 (지금 ${fmt(s.price)}원)` : `${fmt(p)}원`}</dd>
              </div>
              <div>
                <dt>수량</dt>
                <dd className="num">{fmt(qty)}주</dd>
              </div>
              <div className="total">
                <dt>주문금액</dt>
                <dd className="num">약 {fmt(amount)}원</dd>
              </div>
            </dl>
            <p className="sub">{live ? '한투 모의투자 계좌로 주문이 나갑니다 (실제 돈은 움직이지 않음)' : '지금은 예시라 실제로 주문이 나가지 않습니다'}</p>
            <div className="row">
              <button type="button" className="btn" autoFocus onClick={() => setConfirm(false)}>
                취소
              </button>
              <button
                type="button"
                className={`o-go ${side}`}
                disabled={sending}
                onClick={async () => {
                  if (!live) {
                    setConfirm(false);
                    setDone(`(예시) ${s.name} ${fmt(qty)}주 ${sideName} 주문을 받았다고 가정합니다. 실제 주문은 나가지 않았습니다.`);
                    return;
                  }
                  setSending(true);
                  try {
                    const r = await post<{ orderNo: string; orderTime: string; msg: string }>('/api/orders', { code: s.code, side, kind, price: kind === 'market' ? 0 : p, qty });
                    setDone(`모의 주문 접수: ${s.name} ${fmt(qty)}주 ${sideName} · 주문번호 ${r.orderNo || '-'}${r.msg ? ` · ${r.msg}` : ''}`);
                  } catch (e) {
                    setDone(`주문 안 됨: ${e instanceof Error ? e.message : String(e)}`);
                  } finally {
                    setSending(false);
                    setConfirm(false);
                  }
                }}
              >
                {sending ? '보내는 중…' : `${sideName} 확정`}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------- 아래: 종목 정보, 내 보유 ---------- */
function Info({ s, live }: { s: Stock; live: boolean }) {
  const daily = useMemo(() => (live ? [] : sampleDaily(s)), [s, live]);
  const y = daily.slice(-250);
  const lim = s.upper && s.lower ? { upper: s.upper, lower: s.lower } : priceLimits(s.prev);
  const w52h = live ? s.w52h ?? 0 : Math.max(...y.map((k) => k.h));
  const w52l = live ? s.w52l ?? 0 : Math.min(...y.map((k) => k.l));
  const rows: [string, string][] = [
    ['시가총액', live ? `${s.cap.toFixed(1)}조원` : `${((s.cap * s.price) / s.prev).toFixed(1)}조원`],
    ['52주 최고', fmt(w52h)],
    ['52주 최저', fmt(w52l)],
    ['상한가', fmt(lim.upper)],
    ['하한가', fmt(lim.lower)],
    ['PER', live && s.per ? s.per.toFixed(2) : '한투 연결 후'],
    ['PBR', live && s.pbr ? s.pbr.toFixed(2) : '한투 연결 후'],
    ['업종', s.sector],
  ];
  return (
    <section className="panel-t" aria-labelledby="h-info">
      <h2 id="h-info">종목 정보</h2>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={/^[0-9,.]+/.test(v) ? 'num' : undefined}>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function MyHolding({ s, port }: { s: Stock; port: ReturnType<typeof usePortfolio> }) {
  const r = port.rows.find((x) => x.code === s.code);
  return (
    <section className="panel-t" aria-labelledby="h-mine">
      <h2 id="h-mine">내 보유</h2>
      {r ? (
        <dl className="kv">
          {(
            [
              ['수량', `${fmt(r.qty)}주`, 0],
              ['평균단가', fmt(r.avg), 0],
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
    </section>
  );
}
