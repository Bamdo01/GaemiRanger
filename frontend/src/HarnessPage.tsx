import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post, usePoll, useServer } from './api';
import { arrow, changeText, fmt, fmt2, signed, tone } from './lib';

// 투자 하네스 (2026-11-25): 계좌 하나를 맡아 굴리는 자동매매 틀. 지금은 가상 계좌(1천만 원)만.
// AI 가 1시간마다 판단하고, 한도는 서버 코드가 강제한다. 진짜 계좌 주문은 하지 않는다.
type Pos = { key: string; asset: 'kr' | 'us'; code: string; name: string; qty: number; avg: number; price: number; amt: number; pnl: number; pnlPct: number; weight: number };
type Trade = { at: string; side: 'buy' | 'sell'; market: 'kr' | 'us'; code: string; name: string; qty: number; price: number; amount: number; fee: number; tax: number; by: string; reason: string; realized?: number };
type Decision = { at: string; market: 'kr' | 'us'; why: string; view: string; orders: { side?: string; code?: string; amountKrw?: number; qty?: number | string; reason?: string }[]; results: string[]; error: string };
type Acct = {
  id: string;
  name: string;
  enabled: boolean;
  start: number;
  createdAt: string;
  value: { total: number; cash: number; invest: number; pnl: number; pnlPct: number; rows: Pos[]; fx: number };
  today: { day: string; n: number };
  trades: Trade[];
  decisions: Decision[];
  equity: { day: string; value: number }[];
  lastDecide: Record<string, number>;
};
type Limits = { maxPosPct: number; maxTradePct: number; maxTradesDay: number; minCashPct: number; stopPct: number; maxOrdersPerDecision: number; decideEveryMin: number };
type View = { accounts: Acct[]; limits: Limits; sessions: { kr: { code: string; label: string }; us: { code: string; label: string } }; ai: boolean; running: string; lastError: string; fees: { kr: number; krTax: number; us: number } };

const MK: Record<string, string> = { kr: '국내', us: '미국' };
const t16 = (iso: string) => `${iso.slice(5, 10).replace('-', '/')} ${iso.slice(11, 16)}`;

export default function HarnessPage() {
  const { live } = useServer();
  const [v, setV] = useState(0);
  const d = usePoll<View>(live ? `/api/harness?v=${v}` : null, 15_000, true);
  if (!live)
    return (
      <div className="soon">
        <h1>투자 하네스</h1>
        <p>서버에 연결됐을 때 볼 수 있습니다.</p>
      </div>
    );
  if (!d.data) return <div className="soon"><p>{d.error ? `불러오지 못했습니다: ${d.error}` : '불러오는 중…'}</p></div>;
  const x = d.data;
  return (
    <div className="assets harness">
      {x.accounts.map((a) => (
        <AcctView key={a.id} a={a} x={x} reload={() => setV(v + 1)} />
      ))}
      <Rules x={x} />
    </div>
  );
}

function AcctView({ a, x, reload }: { a: Acct; x: View; reload: () => void }) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const val = a.value;
  const run = async (m: 'kr' | 'us') => {
    setBusy(m);
    setMsg('AI 가 판단하는 중입니다… (30초~1분)');
    try {
      const r = await post<Decision>(`/api/harness/${a.id}/decide`, { market: m });
      setMsg(r.error ? `판단 실패: ${r.error}` : `판단 끝: ${r.results.length ? r.results.join(' / ') : '주문 없음'}`);
    } catch (e) {
      setMsg(`안 됨: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
      reload();
    }
  };
  const toggle = async () => {
    await post(`/api/harness/${a.id}/enabled`, { on: !a.enabled });
    reload();
  };
  const next = (m: 'kr' | 'us') => {
    const s = x.sessions[m];
    if (s.code !== 'regular') return `${MK[m]} ${s.label} · 정규장에만 판단`;
    const last = a.lastDecide[m];
    if (!last) return `${MK[m]} 정규장 · 장 시작 30분 뒤부터 1시간마다`;
    const mins = Math.max(0, Math.round((last + x.limits.decideEveryMin * 60 - Date.now() / 1000) / 60));
    return `${MK[m]} 정규장 · 다음 판단 약 ${mins}분 뒤`;
  };
  return (
    <>
      <section className="summary" aria-label={`${a.name} 요약`}>
        <div className="sum-item">
          <span className="sum-k">{a.name} · 가상</span>
          <b className="sum-v">{fmt(val.total)}원</b>
          <span className="sum-s">
            {a.createdAt.slice(0, 10)} 시작 · {fmt(a.start)}원
          </span>
        </div>
        <div className="sum-item">
          <span className="sum-k">수익</span>
          <b className={`sum-v ${tone(val.pnl)}`}>{signed(val.pnl)}원</b>
          <span className={tone(val.pnlPct)}>{changeText(val.pnlPct)}</span>
        </div>
        <div className="sum-item">
          <span className="sum-k">현금</span>
          <b className="sum-v">{fmt(val.cash)}원</b>
          <span className="sum-s">{((val.cash / (val.total || 1)) * 100).toFixed(1)}%</span>
        </div>
        <div className="sum-item">
          <span className="sum-k">오늘 매매</span>
          <b className="sum-v">
            {a.today.n}/{x.limits.maxTradesDay}번
          </b>
          <span className="sum-s">손절 포함</span>
        </div>
      </section>

      <section className="card" aria-labelledby={`h-ctl-${a.id}`}>
        <div className="card-head">
          <h2 id={`h-ctl-${a.id}`}>AI 하네스</h2>
          <span className={`hn-state ${a.enabled ? 'on' : ''}`}>{a.enabled ? '켜짐 · 자동으로 판단' : '꺼짐'}</span>
          <span className="grow" />
          <button type="button" className={`btn sm ${a.enabled ? '' : 'pri'}`} onClick={toggle}>
            {a.enabled ? '끄기' : '켜기'}
          </button>
        </div>
        <ul className="hn-next">
          <li>{next('kr')}</li>
          <li>{next('us')}</li>
        </ul>
        <div className="em-form">
          {(['kr', 'us'] as const).map((m) => (
            <button key={m} type="button" className="btn" disabled={!!busy || !!x.running || x.sessions[m].code !== 'regular' || !x.ai} onClick={() => run(m)} title={x.sessions[m].code !== 'regular' ? '정규장 시간에만' : undefined}>
              {busy === m ? '판단하는 중…' : `${MK[m]} 지금 판단`}
            </button>
          ))}
        </div>
        {msg && <p className={msg.startsWith('안 됨') || msg.startsWith('판단 실패') ? 'o-warn' : 'o-ok'}>{msg}</p>}
        {!x.ai && <p className="o-warn">AI 가 연결돼 있지 않아 판단하지 않습니다 (손절만 동작).</p>}
        {x.lastError && <p className="sub">마지막 오류: {x.lastError}</p>}
      </section>

      <section className="card" aria-labelledby={`h-pos-${a.id}`}>
        <div className="card-head">
          <h2 id={`h-pos-${a.id}`}>보유 {val.rows.length}</h2>
          <span className="sub">환율 {fmt2(val.fx)}원 · 미국 종목은 원화로 환산</span>
        </div>
        {val.rows.length === 0 ? (
          <p className="sub">아직 산 종목이 없습니다. 전부 현금입니다.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>종목</th>
                  <th className="num">수량</th>
                  <th className="num">평균단가</th>
                  <th className="num">현재가</th>
                  <th className="num">평가금액</th>
                  <th className="num">손익</th>
                  <th className="num">비중</th>
                </tr>
              </thead>
              <tbody>
                {val.rows.map((r) => {
                  const p = (n: number) => (r.asset === 'us' ? `$${fmt2(n)}` : fmt(n));
                  return (
                    <tr key={r.key}>
                      <td>
                        <Link to={`/stock/${r.code}`} className="tname">
                          {r.name} <small>{MK[r.asset]} · {r.code}</small>
                        </Link>
                      </td>
                      <td className="num">{fmt(r.qty)}</td>
                      <td className="num">{p(r.avg)}</td>
                      <td className="num">{p(r.price)}</td>
                      <td className="num">{fmt(r.amt)}</td>
                      <td className="num">
                        <span className={tone(r.pnl)}>
                          {arrow(r.pnl)} {signed(r.pnl)} ({changeText(r.pnlPct).replace(/^[▲▼] /, '')})
                        </span>
                      </td>
                      <td className="num">{r.weight.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby={`h-dec-${a.id}`}>
        <div className="card-head">
          <h2 id={`h-dec-${a.id}`}>AI 판단 기록</h2>
          <span className="sub">최근 {a.decisions.length}번</span>
        </div>
        {a.decisions.length === 0 ? (
          <p className="sub">아직 판단한 적이 없습니다. 정규장이 열리고 30분 뒤 첫 판단을 합니다.</p>
        ) : (
          <ul className="hn-log">
            {a.decisions.map((dc, i) => (
              <li key={dc.at + i}>
                <div className="hn-log-head">
                  <span className="num">{t16(dc.at)}</span>
                  <span className="al-kind">{MK[dc.market]}</span>
                  {dc.why !== '정기' && <span className="sub">{dc.why}</span>}
                </div>
                {dc.error ? <p className="o-warn">판단 실패: {dc.error}</p> : <p>{dc.view || '(판단 글 없음)'}</p>}
                {dc.orders.length > 0 ? (
                  <ul className="hn-orders">
                    {dc.orders.map((o, k) => (
                      <li key={k}>
                        <b>{o.side === 'buy' ? '매수' : '매도'} {o.code}</b> {o.amountKrw ? `${fmt(o.amountKrw)}원` : o.qty ? `${o.qty}주` : ''} · {o.reason}
                        <br />
                        <span className={dc.results[k]?.startsWith('체결') ? 'up' : 'sub'}>{dc.results[k]}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  !dc.error && <p className="sub">주문 없음 (지켜봄)</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby={`h-tr-${a.id}`}>
        <div className="card-head">
          <h2 id={`h-tr-${a.id}`}>매매 내역</h2>
          <span className="sub">가상 체결 · 수수료·세금 반영</span>
        </div>
        {a.trades.length === 0 ? (
          <p className="sub">아직 매매가 없습니다.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>구분</th>
                  <th>종목</th>
                  <th className="num">수량</th>
                  <th className="num">가격</th>
                  <th className="num">금액</th>
                  <th>이유</th>
                </tr>
              </thead>
              <tbody>
                {a.trades.map((t, i) => (
                  <tr key={t.at + i}>
                    <td className="num">{t16(t.at)}</td>
                    <td className={t.side === 'buy' ? 'up' : 'dn'}>
                      {t.side === 'buy' ? '매수' : '매도'}
                      {t.by === 'stop' ? ' (손절)' : ''}
                    </td>
                    <td>
                      {t.name} <small className="sub">{t.code}</small>
                    </td>
                    <td className="num">{fmt(t.qty)}</td>
                    <td className="num">{t.market === 'us' ? `$${fmt2(t.price)}` : fmt(t.price)}</td>
                    <td className="num">
                      {fmt(t.amount)}
                      {t.realized !== undefined && <small className={tone(t.realized)}> ({signed(t.realized)})</small>}
                    </td>
                    <td className="hn-why">{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Rules({ x }: { x: View }) {
  const l = x.limits;
  return (
    <section className="card" aria-labelledby="h-hn-rules">
      <div className="card-head">
        <h2 id="h-hn-rules">하네스 규칙 (서버 코드가 강제)</h2>
      </div>
      <ul className="hn-rules">
        <li>판단: AI 가 국내·미국 정규장마다 장 시작 30분 뒤부터 {l.decideEveryMin}분마다. 한 번에 주문안 최대 {l.maxOrdersPerDecision}개</li>
        <li>투자 범위: 코스피200, S&P500·나스닥100·다우30 구성종목과 지정 ETF</li>
        <li>
          한 종목 최대 {l.maxPosPct}% · 한 번 매수 최대 {l.maxTradePct}% · 매수 뒤 현금 {l.minCashPct}% 이상 · 하루 매매 {l.maxTradesDay}번
        </li>
        <li>손절: 평균단가 대비 {l.stopPct}% 면 1분 안에 전량 매도 (AI 판단과 상관없이)</li>
        <li>
          체결: 실제 한투 시세로 바로 체결한 것으로 계산. 수수료 국내 {(x.fees.kr * 100).toFixed(3)}%, 국내 매도 세금 {(x.fees.krTax * 100).toFixed(2)}%, 미국 {(x.fees.us * 100).toFixed(2)}% (환전 비용과 호가 차이는 빠짐)
        </li>
        <li>비상 정지(설정)가 켜지면 아무것도 하지 않습니다. 진짜 계좌 주문은 하지 않습니다.</li>
        <li>보고: 국내 장 마감 뒤 15:45, 미국 장 마감 뒤 06:15 텔레그램</li>
      </ul>
    </section>
  );
}
