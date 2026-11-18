import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import AiReview from './AiReview';
import Heatmap, { Legend, type Tile } from './Heatmap';
import { useMarket } from './hooks';
import { arrow, changeText, fmt, kstTime, signed, tone, type Palette } from './lib';
import { checksOf, usePortfolio, type Portfolio, type Row } from './portfolio';
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

  const navigate = useNavigate();
  const { status, stocks, indices, at } = useMarket();
  const port = usePortfolio(stocks);
  const k = indices.find((i) => i.id === 'kospi');
  const kospiPct = k ? ((k.value - k.prev) / k.prev) * 100 : 0;
  const goStock = (c: string) => navigate(`/stock/${c}`);

  const tiles = useMemo(() => tilesOf(port, colorBy), [port, colorBy]);

  if (port.rows.length === 0)
    return (
      <div className="assets">
        <div className="empty">보유 종목이 없습니다.</div>
      </div>
    );

  const byToday = [...port.rows].sort((a, b) => b.todayPnl - a.todayPnl);
  const best = byToday[0];
  const worst = byToday[byToday.length - 1];

  return (
    <div className="assets">
      <section className="summary" aria-label="내 자산 요약">
        <div className="sum-item">
          <span className="sum-k">총자산</span>
          <b className="sum-v">{fmt(port.total)}원</b>
          <span className="sum-s">{status.open ? `${kstTime(at)} 기준` : status.label} · 예시 데이터</span>
        </div>
        <Sum k="평가손익" v={`${signed(port.pnl)}원`} s={changeText(port.pnlPct)} t={port.pnl} />
        <Sum k="오늘 손익" v={`${signed(port.todayPnl)}원`} s={`${changeText(port.todayPct)} · 코스피 ${changeText(kospiPct)}`} t={port.todayPnl} />
        <div className="sum-item">
          <span className="sum-k">주식 / 현금</span>
          <b className="sum-v">{fmt(port.stockValue)}원</b>
          <span className="sum-s">
            현금 {fmt(port.cash)}원 ({((port.cash / port.total) * 100).toFixed(1)}%)
          </span>
        </div>
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
      </section>

      <div className="as-main">
        <section className="card as-heat" aria-labelledby="h-heat">
          <div className="card-head">
            <h2 id="h-heat">보유 종목</h2>
            <div className="toolbar">
              <Seg id="칸에 보여 줄 값" label="" list={SHOW} cur={colorBy} onPick={(v) => setParam('show', v, SHOW)} />
            </div>
          </div>
          <div className="as-map">
            <Heatmap tiles={tiles} palette={palette} label="보유 종목 히트맵" onPick={goStock} />
          </div>
          <Legend palette={palette} />
        </section>

        <div className="as-side">
          <Checks port={port} kospiPct={kospiPct} />
          <Weights port={port} />
          <AiReview port={port} kospiPct={kospiPct} />
        </div>
      </div>

      <HoldTable port={port} onPick={goStock} />
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

function tilesOf(port: Portfolio, colorBy: string): Tile[] {
  return port.rows.map((r) => ({
    id: r.code,
    group: r.s.sector,
    size: r.amt,
    pct: colorBy === 'profit' ? r.profit : r.today,
    name: r.s.name,
    extra: `${fmt(r.amt)}원 · ${r.weight.toFixed(1)}%`,
    tip: [
      ['수량', `${fmt(r.qty)}주`],
      ['평균단가', `${fmt(r.avg)}원`],
      ['현재가', `${fmt(r.s.price)}원`],
      ['평가금액', `${fmt(r.amt)}원`],
      ['평가손익', `${arrow(r.pnl)} ${signed(r.pnl)}원`],
      ['내 수익률', changeText(r.profit)],
      ['오늘 등락률', changeText(r.today)],
      ['비중', `${r.weight.toFixed(1)}%`],
    ],
  }));
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
  { key: 'qty', label: '수량', get: (r) => r.qty, show: (r) => `${fmt(r.qty)}주`, num: true },
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

function HoldTable({ port, onPick }: { port: Portfolio; onPick: (c: string) => void }) {
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
        <span className="sub">열 머리를 누르면 정렬 · 금액은 원 · 비중은 주식 기준</span>
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
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code}>
                {COLS.map((c) => (
                  <td key={c.key} className={c.num ? 'num' : undefined}>
                    {c.key === 'name' ? (
                      <button type="button" className="tname" onClick={() => onPick(r.code)}>
                        {r.s.name} <small>{r.code}</small>
                      </button>
                    ) : (
                      c.show(r, maxAbs)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>현금 (예수금)</td>
              <td colSpan={3} />
              <td className="num">{fmt(port.cash)}</td>
              <td colSpan={4} />
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
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
