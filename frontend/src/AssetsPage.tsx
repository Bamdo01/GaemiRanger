import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import AiReview from './AiReview';
import Heatmap, { Legend, type Tile } from './Heatmap';
import { useMarket } from './hooks';
import { arrow, changeText, fmt, kstTime, signed, tone, type Palette } from './lib';
import { put, refreshAll } from './api';
import LedgerDrawer, { type Candidate, type Prefill } from './LedgerDrawer';
import { LiveBadge, MovesCard, useFlash } from './Moves';
import { checksOf, qtyText, usePortfolio, type Portfolio, type Row } from './portfolio';
import { Seg, type Opt } from './Pickers';

// 내 자산: 보기 버튼 없이 한 화면 (2026-11-18). 위 요약 줄, 왼쪽 히트맵, 오른쪽 점검·비중·AI 리뷰, 아래 표.
// 히트맵은 업종으로 묶고, 칸에 보여 줄 값(색과 %)만 고른다. 묶음 고르기와 그룹 편집은 2026-11-18 뺐다.
const SHOW: Opt = [['profit', '내 수익률'], ['today', '오늘 등락률']];
// 비중 막대 색. 초록·빨강은 오르내림에 쓰므로 피한다.
const SLICE = ['#4e79a7', '#f28e2b', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];

export default function AssetsPage({ palette }: { palette: Palette }) {
  const [sp, setSp] = useSearchParams();
  const pick = (k: string, o: Opt) => {
    const v = sp.get(k);
    return o.some(([x]) => x === v) ? v! : o[0][0];
  };
  const setParam = (k: string, v: string, o: Opt) => {
    const next = new URLSearchParams(sp);
    if (v === o[0][0]) next.delete(k);
    else next.set(k, v);
    setSp(next, { replace: true });
  };
  const colorBy = pick('show', SHOW);
  const acct = sp.get('acct') ?? 'all';

  const navigate = useNavigate();
  const { status, stocks, indices, at, live } = useMarket();
  const port = usePortfolio(stocks, acct);
  const k = indices.find((i) => i.id === 'kospi');
  const kospiPct = k ? ((k.value - k.prev) / k.prev) * 100 : 0;
  const goStock = (c: string) => /^[0-9][0-9A-Z]{5}$/.test(c) && navigate(`/stock/${c}`);

  const flash = useFlash(port.rows);
  const tiles = useMemo(() => tilesOf(port, colorBy, flash), [port, colorBy, flash]);
  // 기록 서랍 (null 이면 닫힘)
  const [drawer, setDrawer] = useState<Prefill | null>(null);
  const closeDrawer = useCallback(() => setDrawer(null), []);
  const candidates = useMemo<Candidate[]>(() => {
    const m = new Map<string, string>();
    stocks.forEach((s) => m.set(s.code, s.name));
    port.rows.filter((r) => r.asset === 'kr').forEach((r) => m.set(r.code, r.s.name));
    return [...m].map(([code, name]) => ({ code, name }));
  }, [stocks, port.rows]);
  const manualAccounts = port.accounts.filter((a) => !a.linked);
  /** 표의 [＋]: 그 종목·계좌로 채워서 연다 */
  const addFor = (r: Row) => {
    const acc = r.accounts.find((a) => a.id !== 'kis')?.id ?? manualAccounts[0]?.id;
    if (r.asset === 'etc') return setDrawer({ kind: 'value', asset: 'etc', account: acc, name: r.s.name });
    setDrawer({ kind: 'buy', asset: r.asset, account: acc, symbol: r.asset === 'kr' ? r.code : r.code.split(':')[1], name: r.s.name });
  };

  if (!port.loaded)
    return (
      <div className="assets">
        <div className="empty">{port.error ? `잔고를 불러오지 못했습니다: ${port.error}` : '잔고를 불러오는 중입니다…'}</div>
      </div>
    );

  const has = port.rows.length > 0;
  // 오늘 등락은 시세가 있는 국내주식만
  const byToday = port.rows.filter((r) => r.asset === 'kr').sort((a, b) => b.todayPnl - a.todayPnl);
  const best = byToday.length ? byToday[0] : null;
  const worst = byToday.length ? byToday[byToday.length - 1] : null;
  const acctName = acct === 'all' ? '전체 계좌' : port.accounts.find((a) => a.id === acct)?.name ?? acct;
  const setAcct = (v: string) => {
    const next = new URLSearchParams(sp);
    if (v === 'all') next.delete('acct');
    else next.set('acct', v);
    setSp(next, { replace: true });
  };

  return (
    <div className="assets">
      {live && (
        <div className="as-top">
          <label htmlFor="as-acct" className="sub">
            계좌
          </label>
          <select id="as-acct" className="dd" value={acct} onChange={(e) => setAcct(e.target.value)}>
            <option value="all">전체 계좌</option>
            {port.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <LiveBadge />
          {port.usesUsd && <FxChip fx={port.fx} source={port.fxSource} />}
          <span className="grow" />
          <button type="button" className="btn pri" onClick={() => setDrawer({})} aria-haspopup="dialog">
            ＋ 기록
          </button>
        </div>
      )}
      <LedgerDrawer open={drawer !== null} prefill={drawer} onClose={closeDrawer} candidates={candidates} />
      <section className="summary" aria-label="내 자산 요약">
        <div className="sum-item">
          <span className="sum-k">총자산</span>
          <b className="sum-v">{fmt(port.total)}원</b>
          <span className="sum-s">{status.open ? `${kstTime(at)} 기준` : status.label} · {live ? acctName : '예시 데이터'}</span>
        </div>
        <Sum k="평가손익" v={`${signed(port.pnl)}원`} s={changeText(port.pnlPct)} t={port.pnl} />
        <Sum k="오늘 손익" v={`${signed(port.todayPnl)}원`} s={`${changeText(port.todayPct)} · 코스피 ${changeText(kospiPct)}`} t={port.todayPnl} />
        {(port.realized !== 0 || port.dividends !== 0) && (
          <Sum k="실현손익 · 배당" v={`${signed(port.realized)}원`} s={`배당·이자 ${fmt(port.dividends)}원`} t={port.realized} />
        )}
        <div className="sum-item">
          <span className="sum-k">투자 / 현금</span>
          <b className="sum-v">{fmt(port.stockValue)}원</b>
          <span className="sum-s">
            현금 {fmt(port.cash)}원 ({((port.cash / port.total) * 100).toFixed(1)}%)
          </span>
        </div>
        {best && worst && (
          <>
        <button type="button" className="sum-item sum-link" onClick={() => goStock(best.code)}>
          <span className="sum-k">오늘 가장 많이 번 종목</span>
          <b className="sum-v">{best.s.name}</b>
          <span className={tone(best.todayPnl)}>
            {arrow(best.todayPnl)} {signed(best.todayPnl)}원
          </span>
        </button>
        <button type="button" className="sum-item sum-link" onClick={() => goStock(worst.code)}>
          <span className="sum-k">오늘 가장 많이 잃은 종목</span>
          <b className="sum-v">{worst.s.name}</b>
          <span className={tone(worst.todayPnl)}>
            {arrow(worst.todayPnl)} {signed(worst.todayPnl)}원
          </span>
        </button>
          </>
        )}
      </section>

      <div className="as-main">
        <section className="card as-heat" aria-labelledby="h-heat">
          <div className="card-head">
            <h2 id="h-heat">
              보유 종목 · {colorBy === 'profit' ? '내 수익률' : '오늘 등락률'}
              <small className="sub"> {colorBy === 'profit' ? '산 가격 대비' : '어제 종가 대비'}</small>
            </h2>
            <div className="toolbar">
              <Seg id="칸에 보여 줄 값" label="" list={SHOW} cur={colorBy} onPick={(v) => setParam('show', v, SHOW)} />
            </div>
          </div>
          {!has && (
            <p className="sub">
              보유 종목이 없습니다. 종목 페이지에서 매수하거나 수기로 넣으면 여기에 나옵니다.{' '}
              <button type="button" className="link" onClick={() => navigate('/stock')}>
                종목 보러 가기
              </button>
            </p>
          )}
          <div className="as-map">
            <Heatmap tiles={tiles} palette={palette} label={`보유 종목 히트맵, ${colorBy === 'profit' ? '내 수익률' : '오늘 등락률'}`} onPick={goStock} scale={colorBy === 'profit' ? 30 : 3} />
          </div>
          {colorBy === 'profit' ? <Legend palette={palette} scale={30} low="▼ 손실" high="이익 ▲" /> : <Legend palette={palette} />}
        </section>

        <div className="as-side">
          {live && manualAccounts.length === 0 && (
            <section className="card start-card" aria-labelledby="h-start">
              <h2 id="h-start">다른 자산도 합쳐 보기</h2>
              <p className="sub">다른 증권사, 해외주식, 코인, 예금처럼 한투와 연동되지 않는 자산을 기록하면 이 화면 합계에 같이 들어갑니다.</p>
              <button type="button" className="btn pri" onClick={() => setDrawer({ tab: 'accounts' })}>
                첫 계좌 만들기
              </button>
            </section>
          )}
          {live && has && <MovesCard port={port} />}
          {has && <Checks port={port} kospiPct={kospiPct} />}
          <Weights port={port} />
          {has && <AiReview port={port} kospiPct={kospiPct} />}
        </div>
      </div>

      {has && <HoldTable port={port} onPick={goStock} onAdd={live ? addFor : undefined} flash={flash} />}
    </div>
  );
}

function Sum({ k, v, s, t }: { k: string; v: string; s: string; t: number }) {
  return (
    <div className="sum-item">
      <span className="sum-k">{k}</span>
      <b className={`sum-v ${tone(t)}`}>
        {arrow(t)} {v}
      </b>
      <span className="sum-s">{s}</span>
    </div>
  );
}

// 현금도 한 칸으로 넣는다 (2026-11-18 사용자: 내 자산 히트맵에는 현금도 나와야). 칸 크기와 % 는 총자산 기준.
function tilesOf(port: Portfolio, colorBy: string, flash: Record<string, 'up' | 'dn'> = {}): Tile[] {
  const of = (amt: number) => (port.total ? ((amt / port.total) * 100).toFixed(1) : '0.0');
  const stocks: Tile[] = port.rows.map((r) => ({
    id: r.code,
    group: r.s.sector,
    size: r.amt,
    pct: colorBy === 'profit' ? r.profit : r.today,
    name: r.s.name,
    // 고른 값 하나에만 집중 (2026-11-23 사용자: 두 값이 같이 보여 보기 힘듦). 셋째 줄도 그 값의 원 단위
    extra: colorBy === 'profit' ? `${signed(r.pnl)}원` : `오늘 ${signed(r.todayPnl)}원`,
    static: r.asset !== 'kr',
    flash: flash[r.code],
    tip:
      colorBy === 'profit'
        ? [
            ['내 수익률', changeText(r.profit)],
            ['평가손익', `${arrow(r.pnl)} ${signed(r.pnl)}원`],
            ['평균단가', `${fmt(r.avg)}원`],
            ['현재가', `${fmt(r.s.price)}원`],
            ['수량', qtyText(r)],
            ...r.accounts.map((a): [string, string] => [`  ${a.name}`, qtyText({ qty: a.qty, asset: r.asset })]),
            ['평가금액', `${fmt(r.amt)}원 (총자산 중 ${of(r.amt)}%)`],
          ]
        : [
            ['오늘 등락률', changeText(r.today)],
            ['오늘 손익', `${arrow(r.todayPnl)} ${signed(r.todayPnl)}원`],
            ['현재가', `${fmt(r.s.price)}원`],
            ['어제 종가', `${fmt(r.s.prev)}원`],
            ['수량', qtyText(r)],
            ['평가금액', `${fmt(r.amt)}원 (총자산 중 ${of(r.amt)}%)`],
          ],
  }));
  if (port.cash <= 0) return stocks;
  const cash: Tile = {
    id: 'cash',
    group: '', // 묶음 머리(등락률) 없이 따로 한 칸
    size: port.cash,
    pct: 0,
    name: '현금',
    label: `${fmt(port.cash)}원`,
    color: 'var(--cash)',
    static: true,
    tip: [
      ['금액', `${fmt(port.cash)}원`],
      ['총자산 중', `${of(port.cash)}%`],
    ],
  };
  return [...stocks, cash];
}

function Checks({ port, kospiPct }: { port: Portfolio; kospiPct: number }) {
  const { list } = checksOf(port, kospiPct);
  const warns = list.filter((c) => c.warn).length;
  return (
    <section className="card" aria-labelledby="h-check">
      <div className="card-head">
        <h2 id="h-check">점검</h2>
        <span className="sub">{warns ? `확인할 것 ${warns}개` : '모두 괜찮음'}</span>
      </div>
      <ul className="checks">
        {list.map((c) => (
          <li key={c.label} className={c.warn ? 'warn' : 'ok'} title={c.why}>
            <span className="ck-mark" role="img" aria-label={c.warn ? '확인 필요' : '괜찮음'}>
              {c.warn ? '!' : '✓'}
            </span>
            <span className="ck-label">{c.label}</span>
            <b>{c.value}</b>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Weights({ port }: { port: Portfolio }) {
  const slices = [
    ...[...port.rows].sort((a, b) => b.amt - a.amt).map((r, i) => ({ id: r.code, name: r.s.name, amt: r.amt, color: SLICE[i % SLICE.length] })),
    { id: 'cash', name: '현금', amt: port.cash, color: 'var(--cash)' },
  ];
  const pct = (a: number) => `${((a / port.total) * 100).toFixed(1)}%`;
  return (
    <section className="card" aria-labelledby="h-weight">
      <div className="card-head">
        <h2 id="h-weight">자산 비중</h2>
        <span className="sub">현금 포함</span>
      </div>
      <div className="wbar" role="img" aria-label={slices.map((s) => `${s.name} ${pct(s.amt)}`).join(', ')}>
        {slices.map((s) => (
          <i key={s.id} style={{ flexGrow: s.amt, background: s.color }} title={`${s.name} ${pct(s.amt)}`} />
        ))}
      </div>
      <ul className="wlist">
        {slices.map((s) => (
          <li key={s.id}>
            <i style={{ background: s.color }} aria-hidden="true" />
            <span className="wname">{s.name}</span>
            <b>{pct(s.amt)}</b>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------- 표 ---------- */
type Col = { key: string; label: string; get: (r: Row) => number | string; show: (r: Row, maxAbs: number) => ReactNode; num?: boolean };
const COLS: Col[] = [
  { key: 'name', label: '종목', get: (r) => r.s.name, show: (r) => r.s.name },
  { key: 'qty', label: '수량', get: (r) => r.qty, show: (r) => qtyText(r), num: true },
  { key: 'avg', label: '평균단가', get: (r) => r.avg, show: (r) => fmt(r.avg), num: true },
  { key: 'price', label: '현재가', get: (r) => r.s.price, show: (r) => fmt(r.s.price), num: true },
  { key: 'amt', label: '평가금액', get: (r) => r.amt, show: (r) => fmt(r.amt), num: true },
  {
    key: 'pnl',
    label: '평가손익',
    get: (r) => r.pnl,
    show: (r, maxAbs) => (
      <span className="pnl-cell">
        <span className="pbar" aria-hidden="true">
          <i className={r.pnl >= 0 ? 'pos' : 'neg'} style={{ width: `${(Math.abs(r.pnl) / maxAbs) * 50}%` }} />
        </span>
        <span className={tone(r.pnl)}>{`${arrow(r.pnl)} ${signed(r.pnl)}`}</span>
      </span>
    ),
    num: true,
  },
  { key: 'profit', label: '수익률', get: (r) => r.profit, show: (r) => <span className={tone(r.profit)}>{changeText(r.profit)}</span>, num: true },
  { key: 'today', label: '오늘', get: (r) => r.today, show: (r) => <span className={tone(r.today)}>{changeText(r.today)}</span>, num: true },
  { key: 'weight', label: '비중', get: (r) => r.weight, show: (r) => `${r.weight.toFixed(1)}%`, num: true },
];

function HoldTable({ port, onPick, onAdd, flash = {} }: { port: Portfolio; onPick: (c: string) => void; onAdd?: (r: Row) => void; flash?: Record<string, 'up' | 'dn'> }) {
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: 'amt', desc: true });
  const col = COLS.find((c) => c.key === sort.key)!;
  const maxAbs = Math.max(1, ...port.rows.map((r) => Math.abs(r.pnl)));
  const rows = [...port.rows].sort((a, b) => {
    const x = col.get(a);
    const y = col.get(b);
    const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ko');
    return sort.desc ? -d : d;
  });
  return (
    <section className="card" aria-labelledby="h-tbl">
      <div className="card-head">
        <h2 id="h-tbl">보유 종목 표</h2>
        <span className="sub">열 머리를 누르면 정렬 · 금액은 원(달러는 환율로 환산) · 비중은 현금 뺀 투자 기준</span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.key} className={c.num ? 'num' : undefined} aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                  <button type="button" onClick={() => setSort({ key: c.key, desc: sort.key === c.key ? !sort.desc : !!c.num })}>
                    {c.label}
                    <span aria-hidden="true">{sort.key === c.key ? (sort.desc ? ' ▼' : ' ▲') : ''}</span>
                  </button>
                </th>
              ))}
              {onAdd && <th aria-label="기록" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code} className={flash[r.code] ? `flash-${flash[r.code]}` : undefined}>
                {COLS.map((c) => (
                  <td key={c.key} className={c.num ? 'num' : undefined}>
                    {c.key === 'name' && r.asset === 'kr' ? (
                      <button type="button" className="tname" onClick={() => onPick(r.code)}>
                        {r.s.name} <small>{r.code}</small>
                      </button>
                    ) : c.key === 'name' ? (
                      <span className="tname">
                        {r.s.name} <small>{r.s.sector}</small>
                      </span>
                    ) : c.key === 'price' && r.manualPrice && onAdd ? (
                      <PriceCell r={r} />
                    ) : (
                      c.show(r, maxAbs)
                    )}
                  </td>
                ))}
                {onAdd && (
                  <td className="num">
                    <button type="button" className="btn sm add-btn" onClick={() => onAdd(r)} aria-label={`${r.s.name} 기록 추가`} title="이 종목 기록 추가">
                      ＋
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>현금</td>
              <td colSpan={3} />
              <td className="num">{fmt(port.cash)}</td>
              <td colSpan={onAdd ? 5 : 4} />
            </tr>
            <tr className="total">
              <td>합계</td>
              <td colSpan={3} />
              <td className="num">{fmt(port.total)}</td>
              <td className="num">
                <span className={tone(port.pnl)}>{`${arrow(port.pnl)} ${signed(port.pnl)}`}</span>
              </td>
              <td className="num">
                <span className={tone(port.pnl)}>{changeText(port.pnlPct)}</span>
              </td>
              <td className="num">
                <span className={tone(port.todayPnl)}>{changeText(port.todayPct)}</span>
              </td>
              <td className="num">100%</td>
              {onAdd && <td />}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

/** 환율 칩: 눌러서 바로 고친다 */
function FxChip({ fx, source }: { fx: number; source: string }) {
  const [edit, setEdit] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const isDefault = source === 'default';
  // 한투에서 자동으로 받는 중이면 고칠 것 없이 보여 주기만
  if (source === 'auto')
    return (
      <span className="chip fx-chip" title="한투에서 10분마다 받는 원/달러 환율">
        1달러 {fmt(fx)}원 · 자동
      </span>
    );
  if (edit === null)
    return (
      <button type="button" className={`chip fx-chip${isDefault ? ' warn' : ''}`} onClick={() => setEdit(String(fx))} title="눌러서 환율 고치기">
        1달러 {fmt(fx)}원{isDefault ? ' (기본값, 눌러서 넣기)' : ''} ✎
      </button>
    );
  return (
    <form
      className="fx-chip-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await put('/api/ledger/fx', { value: Number(edit) });
          refreshAll();
          setEdit(null);
          setErr('');
        } catch (e2) {
          setErr(e2 instanceof Error ? e2.message : String(e2));
        }
      }}
    >
      1달러 = <input className="in sm" inputMode="decimal" value={edit} onChange={(e) => setEdit(e.target.value)} aria-label="원/달러 환율" autoFocus />원
      <button type="submit" className="btn sm">
        저장
      </button>
      <button type="button" className="btn sm" onClick={() => setEdit(null)}>
        취소
      </button>
      {err && <span className="o-warn">{err}</span>}
    </form>
  );
}

/** 해외주식·코인 현재가: 표에서 눌러 바로 고친다 (원래 통화로) */
function PriceCell({ r }: { r: Row }) {
  const [edit, setEdit] = useState<string | null>(null);
  const usd = r.currency === 'USD';
  if (edit === null)
    return (
      <button type="button" className="price-edit" onClick={() => setEdit(String(r.rawPrice))} title="눌러서 현재가 고치기">
        {fmt(r.s.price)}
        {usd && <small> ${r.rawPrice.toLocaleString('en-US', { maximumFractionDigits: 4 })}</small>} ✎
      </button>
    );
  return (
    <form
      className="price-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await put('/api/ledger/price', { key: r.code, price: Number(edit) });
          refreshAll();
          setEdit(null);
        } catch (e2) {
          window.alert(e2 instanceof Error ? e2.message : String(e2));
        }
      }}
    >
      <input className="in sm" inputMode="decimal" value={edit} onChange={(e) => setEdit(e.target.value)} aria-label={`${r.s.name} 현재가 (${usd ? '달러' : '원'})`} autoFocus onBlur={(e) => !e.currentTarget.form?.contains(e.relatedTarget as Node) && setEdit(null)} />
      <button type="submit" className="btn sm">
        저장
      </button>
    </form>
  );
}
