import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ANT_T } from './Ants';
import Heatmap, { Legend, type Tile } from './Heatmap';
import { useMarket } from './hooks';
import { arrow, changeText, fmt, fmt2, kstTime, signed, signPct, tone, type Palette } from './lib';
import { usePortfolio } from './portfolio';
import { AntSwitch, Seg, type Opt } from './Pickers';

// 보기는 앞으로 늘어날 수 있어서 (코스닥, 관심종목 등) 드롭다운으로 고른다.
// 내 포트폴리오는 2026-11-17 부터 [내 자산] 메뉴에서 본다.
const VIEWS: [string, string][] = [['kospi50', '코스피 상위 50']];
// TradingView 처럼 위쪽에서 고른다. 첫 값이 기본값이고, 기본값은 주소에 남기지 않는다.
const SIZE: Opt = [['cap', '시가총액'], ['equal', '같은 크기']];
const GROUP: Opt = [['sector', '업종'], ['none', '묶지 않음']];

type Props = { palette: Palette; ants: boolean; setAnts: (v: boolean) => void };

export default function MarketPage({ palette, ants, setAnts }: Props) {
  const [sp, setSp] = useSearchParams();
  const pick = (k: string, o: Opt) => {
    const v = sp.get(k);
    return o.some(([x]) => x === v) ? v! : o[0][0];
  };
  const size = pick('size', SIZE);
  const groupBy = pick('group', GROUP);
  const setParam = (k: string, v: string, o: Opt) => {
    const next = new URLSearchParams(sp);
    if (v === o[0][0]) next.delete(k);
    else next.set(k, v);
    setSp(next, { replace: true });
  };

  const navigate = useNavigate();
  const { status, stocks, indices, at } = useMarket();
  const port = usePortfolio(stocks);

  const tiles: Tile[] = useMemo(
    () =>
      stocks.map((s) => {
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
      }),
    [stocks, port, size, groupBy],
  );

  const nHero = tiles.filter((t) => t.pct >= ANT_T).length;
  const nSad = tiles.filter((t) => t.pct <= -ANT_T).length;

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
        <Link to="/assets" className="sum-item sum-link" title="내 자산으로">
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
        <label className="pk" htmlFor="pk-view-sel">
          <span>보기</span>
          <select id="pk-view-sel" className="dd" value="kospi50" onChange={() => undefined}>
            {VIEWS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <Seg id="size" label="크기" list={SIZE} cur={size} onPick={(v) => setParam('size', v, SIZE)} />
        <Seg id="group" label="묶음" list={GROUP} cur={groupBy} onPick={(v) => setParam('group', v, GROUP)} />
        <AntSwitch palette={palette} ants={ants} setAnts={setAnts} />
        <span className="grow" />
        <span className="hint">
          영웅 개미 {nHero} · 눈물 개미 {nSad}
        </span>
      </div>

      <div className="stage">
        <Heatmap tiles={tiles} palette={palette} ants={ants} label="시장 히트맵" onPick={(code) => navigate(`/stock/${code}`)} />
      </div>
      <Legend palette={palette} ants={ants} />
    </div>
  );
}
