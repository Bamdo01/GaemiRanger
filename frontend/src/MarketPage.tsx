import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CASH, HOLDINGS, STOCK_BY_CODE } from './data';
import City, { Legend, type Tile } from './City';
import GroupPanel from './GroupPanel';
import { useGroups, useMarket } from './hooks';
import { arrow, changeText, fmt, fmt2, kstTime, signed, signPct, tone, type Theme } from './lib';

// 보유 종목의 원래 업종 (그룹 기본값). 바뀌지 않으므로 한 번만 만든다.
const HELD = HOLDINGS.map((h) => ({ code: h.code, sector: STOCK_BY_CODE.get(h.code)!.sector }));

export default function MarketPage({ theme }: { theme: Theme }) {
  const [sp, setSp] = useSearchParams();
  const view = sp.get('view') === 'portfolio' ? 'portfolio' : 'market';
  const colorBy = sp.get('color') === 'today' ? 'today' : 'profit';
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(sp);
    if (v === null) next.delete(k);
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
    const maxAmt = Math.max(1, ...rows.map((r) => r.amt));
    return { rows, maxAmt, stockValue, total: stockValue + CASH, pnl: stockValue - cost, pnlPct: cost ? ((stockValue - cost) / cost) * 100 : 0 };
  }, [byCode]);

  const marketTiles: Tile[] = useMemo(
    () =>
      stocks.map((s) => {
        const r = ((s.price - s.prev) / s.prev) * 100;
        const h = port.rows.find((x) => x.code === s.code);
        return {
          id: s.code,
          group: s.sector,
          size: (s.cap * s.price) / s.prev,
          pct: r,
          height: h ? h.amt / port.maxAmt : 0, // 높이 = 내가 가진 금액
          name: s.name,
          extra: `${fmt(s.price)}원`,
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
      }),
    [stocks, port],
  );

  const portTiles: Tile[] = useMemo(
    () =>
      port.rows.map((r) => {
        const w = (r.amt / port.stockValue) * 100;
        const g = groups.groups.find((x) => x.id === groups.assign[r.code]);
        return {
          id: r.code,
          group: g?.name ?? r.s.sector,
          size: r.amt,
          pct: colorBy === 'profit' ? r.profit : r.today,
          height: r.amt / port.maxAmt,
          name: r.s.name,
          extra: `비중 ${w.toFixed(1)}%`,
          tip: [
            ['수량', `${fmt(r.qty)}주`],
            ['평균단가', `${fmt(r.avg)}원`],
            ['현재가', `${fmt(r.s.price)}원`],
            ['평가금액', `${fmt(r.amt)}원`],
            ['평가손익', `${signed(r.pnl)}원`],
            ['내 수익률', changeText(r.profit)],
            ['오늘 등락률', changeText(r.today)],
            ['비중', `${w.toFixed(1)}%`],
          ],
        };
      }),
    [port, groups.groups, groups.assign, colorBy],
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
        <div className="seg" role="group" aria-label="보기">
          <button type="button" aria-pressed={view === 'market'} onClick={() => setParam('view', null)}>
            시장
          </button>
          <button type="button" aria-pressed={view === 'portfolio'} onClick={() => setParam('view', 'portfolio')}>
            내 포트폴리오
          </button>
        </div>
        {view === 'portfolio' && (
          <>
            <div className="seg" role="group" aria-label="색 기준">
              <button type="button" aria-pressed={colorBy === 'profit'} onClick={() => setParam('color', null)}>
                내 수익률
              </button>
              <button type="button" aria-pressed={colorBy === 'today'} onClick={() => setParam('color', 'today')}>
                오늘 등락률
              </button>
            </div>
            <button type="button" className="btn" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
              그룹 편집
            </button>
          </>
        )}
        <span className="grow" />
        <span className="hint">
          {view === 'market' ? '코스피 시가총액 상위 50 · 바닥 = 시가총액 · 높이 = 내가 가진 금액 · 지붕 색 = 오늘 등락률' : `보유 ${port.rows.length}종목 · 바닥·높이 = 내 비중 · 지붕 색 = ${colorBy === 'profit' ? '내 수익률' : '오늘 등락률'}`}
        </span>
      </div>

      <div className="stage">
        {view === 'portfolio' && port.rows.length === 0 ? (
          <div className="empty">보유 종목이 없습니다.</div>
        ) : (
          <City
            tiles={view === 'market' ? marketTiles : portTiles}
            theme={theme}
            label={view === 'market' ? '시장 히트맵' : '내 포트폴리오 히트맵'}
            onPick={(code) => navigate(`/stock/${code}`)}
          />
        )}
        {view === 'portfolio' && editing && (
          <GroupPanel g={groups} holdings={port.rows.map((r) => ({ code: r.code, name: r.s.name }))} onClose={() => setEditing(false)} />
        )}
      </div>
      <Legend theme={theme} height={view === 'market' ? '내가 가진 금액 (안 가진 종목은 낮게)' : '내 비중'} />
    </div>
  );
}
