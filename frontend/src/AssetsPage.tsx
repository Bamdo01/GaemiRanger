import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import AiReview from './AiReview';
import { HeroAnt, SadAnt } from './Ants';
import GroupPanel from './GroupPanel';
import Heatmap, { Legend, type Tile } from './Heatmap';
import { useGroups, useMarket } from './hooks';
import { arrow, changeText, fmt, kstTime, signed, signPct, tone, type Palette } from './lib';
import { HELD, usePortfolio, type Portfolio, type Row } from './portfolio';
import { AntSwitch, Seg, type Opt } from './Pickers';

const VIEWS: Opt = [['magazine', '매거진'], ['heatmap', '히트맵'], ['table', '표']];
const SIZE: Opt = [['hold', '내 보유 금액'], ['equal', '같은 크기']];
const COLOR: Opt = [['profit', '내 수익률'], ['today', '오늘 등락률']];
const GROUP: Opt = [['mine', '내 그룹'], ['sector', '업종'], ['none', '묶지 않음']];
// 비중 막대 색. 초록·빨강은 오르내림에 쓰므로 피한다.
const SLICE = ['#4e79a7', '#f28e2b', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];

type Props = { palette: Palette; ants: boolean; setAnts: (v: boolean) => void };

export default function AssetsPage({ palette, ants, setAnts }: Props) {
  const [sp, setSp] = useSearchParams();
  const pick = (k: string, o: Opt) => {
    const v = sp.get(k);
    return o.some(([x]) => x === v) ? v! : o[0][0];
  };
  const view = pick('view', VIEWS);
  const setParam = (k: string, v: string, o: Opt) => {
    const next = new URLSearchParams(sp);
    if (v === o[0][0]) next.delete(k);
    else next.set(k, v);
    setSp(next, { replace: true });
  };

  const { status, stocks, indices, at } = useMarket();
  const k = indices.find((i) => i.id === 'kospi');
  const kospiPct = k ? ((k.value - k.prev) / k.prev) * 100 : 0;
  const port = usePortfolio(stocks);

  return (
    <div className="assets">
      <div className="toolbar">
        <Seg id="view" label="보기" list={VIEWS} cur={view} onPick={(v) => setParam('view', v, VIEWS)} />
        <span className="grow" />
        <span className="hint">
          {status.open ? `${kstTime(at)} 기준 · 10초마다 갱신` : status.label} · 예시 데이터
        </span>
      </div>
      {port.rows.length === 0 ? (
        <div className="empty">보유 종목이 없습니다.</div>
      ) : view === 'heatmap' ? (
        <HeatView port={port} palette={palette} ants={ants} setAnts={setAnts} pick={pick} setParam={setParam} />
      ) : view === 'table' ? (
        <TableView port={port} />
      ) : (
        <Magazine port={port} palette={palette} ants={ants} kospiPct={kospiPct} />
      )}
    </div>
  );
}

/* ---------- 매거진 ---------- */
function Magazine({ port, palette, ants, kospiPct }: { port: Portfolio; palette: Palette; ants: boolean; kospiPct: number }) {
  const navigate = useNavigate();
  const byToday = [...port.rows].sort((a, b) => b.todayPnl - a.todayPnl);
  const best = byToday[0].todayPnl > 0 ? byToday[0] : null;
  const worst = byToday[byToday.length - 1].todayPnl < 0 ? byToday[byToday.length - 1] : null;
  const date = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });

  const slices = [
    ...[...port.rows].sort((a, b) => b.amt - a.amt).map((r, i) => ({ id: r.code, name: r.s.name, amt: r.amt, color: SLICE[i % SLICE.length] })),
    { id: 'cash', name: '현금', amt: port.cash, color: 'var(--cash)' },
  ];
  const contrib = [...port.rows].sort((a, b) => b.pnl - a.pnl);
  const maxAbs = Math.max(1, ...contrib.map((r) => Math.abs(r.pnl)));

  return (
    <article className="mag">
      <header className="mag-head">
        <p className="kicker">총자산 · {date} 기준</p>
        <h1 className="mag-total">
          {fmt(port.total)}
          <small>원</small>
        </h1>
        <p className="deck">
          <span>
            평가손익{' '}
            <b className={tone(port.pnl)}>
              {arrow(port.pnl)} {signed(port.pnl)}원 ({signPct(port.pnlPct)})
            </b>
          </span>
          <span>
            오늘{' '}
            <b className={tone(port.todayPnl)}>
              {arrow(port.todayPnl)} {signed(port.todayPnl)}원 ({signPct(port.todayPct)})
            </b>
          </span>
          <span>
            주식 <b>{fmt(port.stockValue)}원</b> · 현금 <b>{fmt(port.cash)}원</b>
          </span>
        </p>
      </header>

      <AiReview port={port} kospiPct={kospiPct} />

      <div className="mag-grid">
        <Story kind="hero" row={best} palette={palette} ants={ants} onPick={(c) => navigate(`/stock/${c}`)} />
        <Story kind="sad" row={worst} palette={palette} ants={ants} onPick={(c) => navigate(`/stock/${c}`)} />

        <section className="card weight" aria-labelledby="h-weight">
          <h2 id="h-weight">자산 비중</h2>
          <div className="wbar" role="img" aria-label={slices.map((s) => `${s.name} ${((s.amt / port.total) * 100).toFixed(1)}%`).join(', ')}>
            {slices.map((s) => (
              <i key={s.id} style={{ flexGrow: s.amt, background: s.color }} />
            ))}
          </div>
          <ul className="wlist">
            {slices.map((s) => (
              <li key={s.id}>
                <i style={{ background: s.color }} aria-hidden="true" />
                <span className="wname">{s.name}</span>
                <b>{((s.amt / port.total) * 100).toFixed(1)}%</b>
                <span className="wamt">{fmt(s.amt)}원</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card contrib" aria-labelledby="h-contrib">
          <h2 id="h-contrib">종목별 평가손익</h2>
          <p className="sub">평균단가 대비 평가손익</p>
          <ul className="clist">
            {contrib.map((r) => (
              <li key={r.code}>
                <button type="button" className="cname" onClick={() => navigate(`/stock/${r.code}`)}>
                  {r.s.name}
                </button>
                <span className="cbar">
                  <i className={r.pnl >= 0 ? 'pos' : 'neg'} style={{ width: `${(Math.abs(r.pnl) / maxAbs) * 50}%` }} />
                </span>
                <b className={tone(r.pnl)}>
                  {arrow(r.pnl)} {signed(r.pnl)}원
                </b>
              </li>
            ))}
          </ul>
        </section>

        <section className="card mini" aria-labelledby="h-mini">
          <div className="card-head">
            <h2 id="h-mini">보유 종목 히트맵</h2>
            <Link to="/assets?view=heatmap" className="chip">
              히트맵으로 크게
            </Link>
          </div>
          <div className="mini-map">
            <Heatmap tiles={tilesOf(port, 'hold', 'profit', 'none', [])} palette={palette} ants={ants} label="내 자산 작은 히트맵" onPick={(c) => navigate(`/stock/${c}`)} />
          </div>
        </section>
      </div>
    </article>
  );
}

function Story({ kind, row, palette, ants, onPick }: { kind: 'hero' | 'sad'; row: Row | null; palette: Palette; ants: boolean; onPick: (c: string) => void }) {
  const title = kind === 'hero' ? '오늘 가장 많이 번 종목' : '오늘 가장 많이 잃은 종목';
  return (
    <section className={`card story ${kind}`} aria-label={title}>
      <p className="kicker">{title}</p>
      {row ? (
        <>
          <button type="button" className="story-name" onClick={() => onPick(row.code)}>
            {row.s.name}
          </button>
          <p className={`story-num ${tone(row.todayPnl)}`}>
            {arrow(row.todayPnl)} {signed(row.todayPnl)}원
          </p>
          <p className="sub">
            오늘 {changeText(row.today)} · {fmt(row.qty)}주 · 내 수익률 {changeText(row.profit)}
          </p>
        </>
      ) : (
        <p className="sub">{kind === 'hero' ? '오늘 오른 종목이 없어요' : '오늘 내린 종목이 없어요'}</p>
      )}
      {ants && <span className="story-ant">{kind === 'hero' ? <HeroAnt palette={palette} /> : <SadAnt palette={palette} />}</span>}
    </section>
  );
}

/* ---------- 히트맵 ---------- */
function tilesOf(port: Portfolio, size: string, colorBy: string, groupBy: string, groupName: (string | undefined)[]): Tile[] {
  return port.rows.map((r, i) => ({
    id: r.code,
    group: groupBy === 'none' ? '' : groupBy === 'mine' ? groupName[i] ?? r.s.sector : r.s.sector,
    size: size === 'equal' ? 1 : r.amt,
    pct: colorBy === 'profit' ? r.profit : r.today,
    name: r.s.name,
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

type HeatProps = {
  port: Portfolio;
  palette: Palette;
  ants: boolean;
  setAnts: (v: boolean) => void;
  pick: (k: string, o: Opt) => string;
  setParam: (k: string, v: string, o: Opt) => void;
};
function HeatView({ port, palette, ants, setAnts, pick, setParam }: HeatProps) {
  const navigate = useNavigate();
  const groups = useGroups(HELD);
  const [editing, setEditing] = useState(false);
  const size = pick('size', SIZE);
  const colorBy = pick('color', COLOR);
  const groupBy = pick('group', GROUP);
  const names = port.rows.map((r) => groups.groups.find((g) => g.id === groups.assign[r.code])?.name);
  const tiles = useMemo(() => tilesOf(port, size, colorBy, groupBy, names), [port, size, colorBy, groupBy, names.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="toolbar">
        <Seg id="size" label="크기" list={SIZE} cur={size} onPick={(v) => setParam('size', v, SIZE)} />
        <Seg id="color" label="색" list={COLOR} cur={colorBy} onPick={(v) => setParam('color', v, COLOR)} />
        <Seg id="group" label="묶음" list={GROUP} cur={groupBy} onPick={(v) => setParam('group', v, GROUP)} />
        <AntSwitch palette={palette} ants={ants} setAnts={setAnts} />
        {groupBy === 'mine' && (
          <button type="button" className="chip" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
            그룹 편집
          </button>
        )}
      </div>
      <div className="stage">
        <Heatmap tiles={tiles} palette={palette} ants={ants} label="내 자산 히트맵" onPick={(c) => navigate(`/stock/${c}`)} />
        {groupBy === 'mine' && editing && <GroupPanel g={groups} holdings={port.rows.map((r) => ({ code: r.code, name: r.s.name }))} onClose={() => setEditing(false)} />}
      </div>
      <Legend palette={palette} ants={ants} />
    </>
  );
}

/* ---------- 표 ---------- */
type Col = { key: keyof Row | 'name'; label: string; get: (r: Row) => number | string; show: (r: Row) => ReactNode; num?: boolean };
const COLS: Col[] = [
  { key: 'name', label: '종목', get: (r) => r.s.name, show: (r) => r.s.name },
  { key: 'qty', label: '수량', get: (r) => r.qty, show: (r) => `${fmt(r.qty)}주`, num: true },
  { key: 'avg', label: '평균단가', get: (r) => r.avg, show: (r) => fmt(r.avg), num: true },
  { key: 's', label: '현재가', get: (r) => r.s.price, show: (r) => fmt(r.s.price), num: true },
  { key: 'amt', label: '평가금액', get: (r) => r.amt, show: (r) => fmt(r.amt), num: true },
  { key: 'pnl', label: '평가손익', get: (r) => r.pnl, show: (r) => <span className={tone(r.pnl)}>{`${arrow(r.pnl)} ${signed(r.pnl)}`}</span>, num: true },
  { key: 'profit', label: '수익률', get: (r) => r.profit, show: (r) => <span className={tone(r.profit)}>{changeText(r.profit)}</span>, num: true },
  { key: 'today', label: '오늘', get: (r) => r.today, show: (r) => <span className={tone(r.today)}>{changeText(r.today)}</span>, num: true },
  { key: 'weight', label: '비중', get: (r) => r.weight, show: (r) => `${r.weight.toFixed(1)}%`, num: true },
];

function TableView({ port }: { port: Portfolio }) {
  const navigate = useNavigate();
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: 'amt', desc: true });
  const col = COLS.find((c) => c.key === sort.key)!;
  const rows = [...port.rows].sort((a, b) => {
    const x = col.get(a);
    const y = col.get(b);
    const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ko');
    return sort.desc ? -d : d;
  });
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {COLS.map((c) => (
              <th key={c.key} className={c.num ? 'num' : undefined} aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                <button type="button" onClick={() => setSort({ key: c.key, desc: sort.key === c.key ? !sort.desc : c.num ?? false })}>
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
                    <button type="button" className="tname" onClick={() => navigate(`/stock/${r.code}`)}>
                      {r.s.name} <small>{r.code}</small>
                    </button>
                  ) : (
                    c.show(r)
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
      <p className="note">비중은 주식만 기준입니다. 금액 단위는 원입니다. 열 머리를 누르면 정렬합니다.</p>
    </div>
  );
}
