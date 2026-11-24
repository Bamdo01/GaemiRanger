import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Heatmap, { Legend, type Tile } from './Heatmap';
import { useMarket } from './hooks';
import { sampleTrade } from './data';
import { arrow, changeText, fmt, shares, signed, signPct, stampOf, tone, won, type Palette } from './lib';
import MarketBar from './Indices';
import { usePortfolio } from './portfolio';
import { Seg, type Opt } from './Pickers';

// 보기는 앞으로 늘어날 수 있어서 (코스닥, 관심종목 등) 드롭다운으로 고른다.
// 내 포트폴리오는 2026-11-17 부터 [내 자산] 메뉴에서 본다.
const VIEWS: [string, string][] = [['kospi50', '코스피 상위 50']];
// TradingView 처럼 위쪽에서 고른다. 첫 값이 기본값이고, 기본값은 주소에 남기지 않는다.
// 크기는 TradingView 를 참고해 드롭다운 (2026-11-18). 거래량·거래대금은 지금 예시 값.
const SIZE: Opt = [
  ['cap', '시가총액'],
  ['vol1d', '거래량 1일'],
  ['vol1w', '거래량 1주'],
  ['vol1m', '거래량 1달'],
  ['val1d', '거래대금 1일'],
  ['val1w', '거래대금 1주'],
  ['val1m', '거래대금 1달'],
  ['equal', '같은 크기'],
];
const PERIOD: Record<string, number> = { '1d': 0, '1w': 1, '1m': 2 };
const GROUP: Opt = [['sector', '업종'], ['none', '묶지 않음']];

type Props = { palette: Palette };

export default function MarketPage({ palette }: Props) {
  const [sp, setSp] = useSearchParams();
  const pick = (k: string, o: Opt) => {
    const v = sp.get(k);
    return o.some(([x]) => x === v) ? v! : o[0][0];
  };
  const picked = pick('size', SIZE);
  const groupBy = pick('group', GROUP);
  const setParam = (k: string, v: string, o: Opt) => {
    const next = new URLSearchParams(sp);
    if (v === o[0][0]) next.delete(k);
    else next.set(k, v);
    setSp(next, { replace: true });
  };

  const navigate = useNavigate();
  const { status, stocks, indices, at, live, error } = useMarket();
  // 서버(한투) 값일 때 1주·1달 거래량은 아직 없다 → 1일로
  const size = live && /1[wm]$/.test(picked) ? picked.replace(/1[wm]$/, '1d') : picked;
  const port = usePortfolio(stocks);

  const tiles: Tile[] = useMemo(
    () =>
      stocks.map((s) => {
        const r = ((s.price - s.prev) / s.prev) * 100;
        const h = port.rows.find((x) => x.code === s.code);
        const tr = live ? { vol: [s.vol ?? 0, NaN, NaN], val: [s.val ?? 0, NaN, NaN] } : sampleTrade(s);
        const kind = size.slice(0, 3); // cap, vol, val, equ
        const i = PERIOD[size.slice(3)] ?? 0;
        const metric = kind === 'vol' ? tr.vol[i] : kind === 'val' ? tr.val[i] : 0;
        const label = SIZE.find(([v]) => v === size)![1];
        return {
          id: s.code,
          group: groupBy === 'none' ? '' : s.sector,
          size: size === 'equal' ? 1 : kind === 'vol' || kind === 'val' ? metric : (s.cap * s.price) / s.prev,
          extra: kind === 'vol' ? shares(metric) : kind === 'val' ? won(metric) : undefined,
          pct: r,
          name: s.name,
          held: !!h,
          tip: [
            ['코드', s.code],
            ['현재가', `${fmt(s.price)}원`],
            ['전일 대비', `${arrow(s.price - s.prev)} ${signed(s.price - s.prev)}원`],
            ['등락률', changeText(r)],
            ['시가총액', `${((s.cap * s.price) / s.prev).toFixed(1)}조원`],
            ['거래량 1일', shares(tr.vol[0])],
            ['거래대금 1일', won(tr.val[0])],
            ...(kind !== 'cap' && kind !== 'equ' && i > 0 ? ([[label, kind === 'vol' ? shares(metric) : won(metric)]] as [string, string][]) : []),
            ['업종', s.sector],
            ...(h ? ([['내 보유', `${fmt(h.amt)}원`], ['내 수익률', changeText(h.profit)]] as [string, string][]) : []),
          ],
        };
      }),
    [stocks, port, size, groupBy],
  );


  return (
    <div className="market">
      <MarketBar status={status} indices={indices} />
      <section className="summary" aria-label="요약">
        <Link to="/assets" className="sum-item sum-link" title="내 자산으로">
          <span className="sum-k">내 자산</span>
          <b className="sum-v">{fmt(port.total)}원</b>
          <span className={tone(port.pnl)}>
            {arrow(port.pnl)} {signed(port.pnl)}원 ({signPct(port.pnlPct)})
          </span>
        </Link>
        <span className="grow" />
        <span className="stamp">
          {status.moving ? `${stampOf(status, at)} · 10초마다 갱신` : status.label}
          <em>{live ? `한투 · ${stocks.length}/50종목${error ? ` · 갱신 실패: ${error}` : ''}` : '예시 데이터'}</em>
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
        <label className="pk" htmlFor="pk-size-sel">
          <span>크기</span>
          <select id="pk-size-sel" className="dd" value={size} onChange={(e) => setParam('size', e.target.value, SIZE)}>
            {SIZE.map(([v, l]) => (
              <option key={v} value={v} disabled={live && /1[wm]$/.test(v)}>
                {live && /1[wm]$/.test(v) ? `${l} (준비 중)` : l}
              </option>
            ))}
          </select>
        </label>
        <Seg id="group" label="묶음" list={GROUP} cur={groupBy} onPick={(v) => setParam('group', v, GROUP)} />
      </div>

      <div className="stage">
        {live && stocks.length === 0 ? (
          <div className="empty">한투에서 시세를 받는 중입니다. 서버를 켠 직후에는 50종목이 다 채워지는 데 1분쯤 걸립니다.</div>
        ) : (
          <Heatmap tiles={tiles} palette={palette} label="시장 히트맵" onPick={(code) => navigate(`/stock/${code}`)} />
        )}
      </div>
      <Legend palette={palette} />
    </div>
  );
}
