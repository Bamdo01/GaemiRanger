import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ANT_T, HeroAnt } from './Ants';
import { CASH, HOLDINGS, STOCK_BY_CODE } from './data';
import GroupPanel from './GroupPanel';
import Heatmap, { Legend, type Tile } from './Heatmap';
import { useGroups, useMarket } from './hooks';
import { arrow, changeText, fmt, fmt2, kstTime, signed, signPct, tone, type Palette } from './lib';

// 보유 종목의 원래 업종 (그룹 기본값). 바뀌지 않으므로 한 번만 만든다.
const HELD = HOLDINGS.map((h) => ({ code: h.code, sector: STOCK_BY_CODE.get(h.code)!.sector }));

type View = 'market' | 'portfolio';
type Opt = [string, string][];
// TradingView 처럼 위쪽에서 고른다. 첫 값이 기본값이고, 기본값은 주소에 남기지 않는다.
const OPTS: Record<View, { size: Opt; color: Opt; group: Opt }> = {
  market: {
    size: [['cap', '시가총액'], ['equal', '같은 크기']],
    color: [['today', '오늘 등락률']],
    group: [['sector', '업종'], ['none', '묶지 않음']],
  },
  portfolio: {
    size: [['hold', '내 보유 금액'], ['cap', '시가총액'], ['equal', '같은 크기']],
    color: [['profit', '내 수익률'], ['today', '오늘 등락률']],
    group: [['mine', '내 그룹'], ['sector', '업종'], ['none', '묶지 않음']],
  },
};

export default function MarketPage({ palette, ants, setAnts }: { palette: Palette; ants: boolean; setAnts: (v: boolean) => void }) {
  const [sp, setSp] = useSearchParams();
  const view: View = sp.get('view') === 'portfolio' ? 'portfolio' : 'market';
  const o = OPTS[view];
  const pick = (k: 'size' | 'color' | 'group') => {
    const v = sp.get(k);
    return o[k].some(([x]) => x === v) ? v! : o[k][0][0];
  };
  const size = pick('size');
  const colorBy = pick('color');
  const groupBy = pick('group');
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(sp);
    if (k === 'view') {
      ['size', 'color', 'group'].forEach((x) => next.delete(x));
      if (v === 'market') next.delete('view');
      else next.set('view', v);
    } else if (v === o[k as 'size'][0][0]) next.delete(k);
    else next.set(k, v);
    setSp(next, { replace: true });
  };

  const navigate = useNavigate();
  const { status, stocks, indices, at } = useMarket();
  const groups = useGroups(HELD);
  const [editing, setEditing] = useState(false);
  const byCode = useMemo(() => new Map(stocks.map((s) => [s.code, s])), [stocks]);

  const port = useMemo(() => {
    const rows = HOLDINGS.map((h) => {
      const s = byCode.get(h.code)!;
      const amt = h.qty * s.price;
      return { ...h, s, amt, pnl: amt - h.qty * h.avg, profit: ((s.price - h.avg) / h.avg) * 100, today: ((s.price - s.prev) / s.prev) * 100 };
    });
    const stockValue = rows.reduce((a, r) => a + r.amt, 0);
    const cost = rows.reduce((a, r) => a + r.qty * r.avg, 0);
    return { rows, stockValue, total: stockValue + CASH, pnl: stockValue - cost, pnlPct: cost ? ((stockValue - cost) / cost) * 100 : 0 };
  }, [byCode]);

  const tiles: Tile[] = useMemo(() => {
    if (view === 'market')
      return stocks.map((s) => {
        const r = ((s.price - s.prev) / s.prev) * 100;
        const h = port.rows.find((x) => x.code === s.code);
        return {
          id: s.code,
          group: groupBy === 'none' ? '' : s.sector,
          size: size === 'equal' ? 1 : (s.cap * s.price) / s.prev,
          pct: r,
          name: s.name,
          held: !!h,
          tip: [
            ['코드', s.code],
            ['현재가', `${fmt(s.price)}원`],
            ['전일 대비', `${arrow(s.price - s.prev)} ${signed(s.price - s.prev)}원`],
            ['등락률', changeText(r)],
            ['시가총액', `${((s.cap * s.price) / s.prev).toFixed(1)}조원`],
            ['업종', s.sector],
            ...(h ? ([['내 보유', `${fmt(h.amt)}원`], ['내 수익률', changeText(h.profit)]] as [string, string][]) : []),
          ],
        };
      });
    return port.rows.map((r) => {
      const w = (r.amt / port.stockValue) * 100;
      const g = groups.groups.find((x) => x.id === groups.assign[r.code]);
      return {
        id: r.code,
        group: groupBy === 'none' ? '' : groupBy === 'mine' ? g?.name ?? r.s.sector : r.s.sector,
        size: size === 'equal' ? 1 : size === 'cap' ? r.s.cap : r.amt,
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
          ['비중', `${w.toFixed(1)}%`],
        ],
      };
    });
  }, [view, stocks, port, groups.groups, groups.assign, size, colorBy, groupBy]);

  const nHero = tiles.filter((t) => t.pct >= ANT_T).length;
  const nSad = tiles.filter((t) => t.pct <= -ANT_T).length;

  const seg = (k: 'view' | 'size' | 'color' | 'group', label: string, list: Opt, cur: string) => (
    <div className="pk">
      <span id={`pk-${k}`}>{label}</span>
      <div className="seg" role="group" aria-labelledby={`pk-${k}`}>
        {list.map(([v, l]) => (
          <button key={v} type="button" aria-pressed={cur === v} onClick={() => setParam(k, v)}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="market">
      <section className="summary" aria-label="요약">
        {indices.map((i) => {
          const d = i.value - i.prev;
          const p = (d / i.prev) * 100;
          return (
            <div key={i.id} className="sum-item">
              <span className="sum-k">{i.name}</span>
              <b className="sum-v">{fmt2(i.value)}</b>
              <span className={tone(d)}>
                {arrow(d)} {signed(d, fmt2)} ({signPct(p)})
              </span>
            </div>
          );
        })}
        <Link to="/account" className="sum-item sum-link" title="계좌 페이지로">
          <span className="sum-k">내 자산</span>
          <b className="sum-v">{fmt(port.total)}원</b>
          <span className={tone(port.pnl)}>
            {arrow(port.pnl)} {signed(port.pnl)}원 ({signPct(port.pnlPct)})
          </span>
        </Link>
        <span className="grow" />
        <span className="stamp">
          {status.open ? `${kstTime(at)} 기준 · 10초마다 갱신` : status.label}
          <em>예시 데이터</em>
        </span>
      </section>

      <div className="toolbar">
        {seg('view', '보기', [['market', '코스피 상위 50'], ['portfolio', '내 포트폴리오']], view)}
        {seg('size', '크기', o.size, size)}
        {o.color.length > 1 && seg('color', '색', o.color, colorBy)}
        {seg('group', '묶음', o.group, groupBy)}
        <button type="button" className="chip" aria-pressed={ants} onClick={() => setAnts(!ants)}>
          <HeroAnt palette={palette} /> 개미 {ants ? '켬' : '끔'}
        </button>
        {view === 'portfolio' && groupBy === 'mine' && (
          <button type="button" className="chip" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
            그룹 편집
          </button>
        )}
        <span className="grow" />
        <span className="hint">
          영웅 개미 {nHero} · 눈물 개미 {nSad}
        </span>
      </div>

      <div className="stage">
        {view === 'portfolio' && port.rows.length === 0 ? (
          <div className="empty">보유 종목이 없습니다.</div>
        ) : (
          <Heatmap
            tiles={tiles}
            palette={palette}
            ants={ants}
            label={view === 'market' ? '시장 히트맵' : '내 포트폴리오 히트맵'}
            onPick={(code) => navigate(`/stock/${code}`)}
          />
        )}
        {view === 'portfolio' && groupBy === 'mine' && editing && (
          <GroupPanel g={groups} holdings={port.rows.map((r) => ({ code: r.code, name: r.s.name }))} onClose={() => setEditing(false)} />
        )}
      </div>
      <Legend palette={palette} ants={ants} />
    </div>
  );
}
