import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { post, usePoll, useServer } from './api';
import { arrow, changeText, fmt, fmt2, signed, tone } from './lib';
import { HqCard, LimitsCard, type Hq, type LimitsT } from './HarnessParts';
import AntFace from './AntFace';
import { AntDex, AntView, PickAnts, TeamAnts, type Ant } from './AntsDex';

// 투자 하네스 (2026-11-25): 계좌 하나를 맡아 굴리는 자동매매 틀. 지금은 가상 계좌(1천만 원)만.
// AI 가 1시간마다 판단하고, 한도는 서버 코드가 강제한다. 진짜 계좌 주문은 하지 않는다.
type Pos = { key: string; asset: 'kr' | 'us'; code: string; name: string; qty: number; avg: number; price: number; amt: number; pnl: number; pnlPct: number; weight: number };
type Trade = { at: string; side: 'buy' | 'sell'; market: 'kr' | 'us'; code: string; name: string; qty: number; price: number; amount: number; fee: number; tax: number; by: string; reason: string; realized?: number };
type Say = { id: string; color?: number; role: string; persona: string; temper: string; name: string; text: string; stance?: string; picks: { side?: string; code?: string; reason?: string }[]; block: string[] };
type Decision = { at: string; market: 'kr' | 'us'; why: string; view: string; orders: { side?: string; code?: string; amountKrw?: number; qty?: number | string; reason?: string }[]; results: string[]; error: string; debate?: Say[]; block?: string[]; debateAt?: string; manager?: string; limits?: string[]; limitsWhy?: string };
type Member = { id: string; role: string; persona: string; temper: string; name: string; color: number };
type Item = { name: string; desc: string };
type Catalog = { roles: Record<string, Item>; personas: Record<string, Item>; tempers: Record<string, Item>; colors: string[] };
type Acct = {
  id: string;
  name: string;
  strategy: 'ai' | 'team';
  team: Member[];
  debate: Record<string, { day: string; at: string; talk: Say[]; block: string[] }>;
  enabled: boolean;
  start: number;
  createdAt: string;
  value: { total: number; cash: number; invest: number; pnl: number; pnlPct: number; rows: Pos[]; fx: number };
  today: { day: string; n: number };
  trades: Trade[];
  decisions: Decision[];
  equity: { day: string; value: number }[];
  lastDecide: Record<string, number>;
  limits: LimitsT;
  limitLog: { at: string; by: string; changes: string[]; why: string }[];
  halted: string;
  agents: string[];
};
type Limits = { maxPosPct: number; maxTradePct: number; maxTradesDay: number; minCashPct: number; stopPct: number; maxOrdersPerDecision: number; decideEveryMin: number };
type View = { accounts: Acct[]; ants: Ant[]; catalog: Catalog; limits: Limits; hard: Record<string, [number, number]>; haltPct: number; hq: Hq; sessions: { kr: { code: string; label: string }; us: { code: string; label: string } }; ai: boolean; running: string; lastError: string; fees: { kr: number; krTax: number; us: number } };

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
  return <Accounts x={x} reload={() => setV(v + 1)} />;
}

/** 계좌 고르기 + 비교 + 새 계좌 */
function Accounts({ x, reload }: { x: View; reload: () => void }) {
  const [sp, setSp] = useSearchParams();
  const sel = x.accounts.find((a) => a.id === sp.get('a')) ?? x.accounts[0];
  const pick = (id: string) => {
    const n = new URLSearchParams(sp);
    n.set('a', id);
    n.delete('m');
    setSp(n, { replace: true });
  };
  // 개미 한 마리 보기 (?m=), 개미 도감 (?v=ants). 뒤로 가기로 돌아올 수 있게 기록을 남긴다
  const ant = x.ants.find((g) => g.id === sp.get('m'));
  const dex = sp.get('v') === 'ants';
  const go = (k: 'm' | 'v', val: string) => {
    const n = new URLSearchParams(sp);
    if (val) n.set(k, val);
    else n.delete(k);
    if (k === 'v') n.delete('m');
    setSp(n);
    window.scrollTo(0, 0);
  };
  const pickAgent = (id: string) => go('m', id);
  const [adding, setAdding] = useState(false);
  return (
    <div className="assets harness">
      <div className="m-acct hn-acct" role="group" aria-label="가상 계좌 고르기">
        <button type="button" className="hn-dex-pill" aria-pressed={dex} onClick={() => go('v', dex ? '' : 'ants')}>
          🐜 개미 도감
        </button>
        {x.accounts.map((a) => (
          <button key={a.id} type="button" aria-pressed={!dex && a.id === sel.id} onClick={() => { pick(a.id); if (dex) go('v', ''); }}>
            {a.name} <span className={tone(a.value.pnlPct)}>{a.value.pnlPct >= 0 ? '+' : ''}{a.value.pnlPct.toFixed(2)}%</span>
          </button>
        ))}
        <button type="button" onClick={() => setAdding(!adding)} aria-expanded={adding}>
          ＋ 새 가상 계좌
        </button>
      </div>
      {adding && <NewAccount x={x} done={(id) => { setAdding(false); reload(); if (id) pick(id); }} />}
      {ant ? (
        <AntView a={ant} catalog={x.catalog} ai={x.ai} back={() => window.history.back()} reload={reload} />
      ) : dex ? (
        <AntDex ants={x.ants} catalog={x.catalog} ai={x.ai} reload={reload} onPick={pickAgent} />
      ) : (
        <>
          {x.accounts.length > 1 && <Compare x={x} />}
          {sel && <AcctView key={sel.id} a={sel} x={x} reload={reload} onAgent={pickAgent} />}
          <HqCard hq={x.hq} accounts={x.accounts.map((a) => ({ id: a.id, name: a.name, cash: a.value.cash }))} ai={x.ai} reload={reload} />
          <Rules x={x} />
        </>
      )}
    </div>
  );
}

function Compare({ x }: { x: View }) {
  return (
    <section className="card" aria-labelledby="h-hn-cmp">
      <div className="card-head">
        <h2 id="h-hn-cmp">계좌 비교</h2>
        <span className="sub">수익률은 맡은 돈 대비 (본부가 옮긴 돈 반영) · 한도는 계좌마다 AI 가 정함</span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>계좌</th>
              <th>방식</th>
              <th className="num">맡은 돈</th>
              <th className="num">총평가</th>
              <th className="num">수익률</th>
              <th className="num">현금</th>
              <th className="num">매매</th>
              <th>시작</th>
            </tr>
          </thead>
          <tbody>
            {[...x.accounts].sort((a, b) => b.value.pnlPct - a.value.pnlPct).map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td className="sub">
                  <span className="hn-faces">
                    {a.team.map((m) => (
                      <AntFace key={m.id} color={m.color} role={m.role} temper={m.temper} size={20} title={m.name} />
                    ))}
                  </span>
                  {a.halted ? ' 정지' : ''}
                </td>
                <td className="num">{fmt(a.start)}</td>
                <td className="num">{fmt(a.value.total)}</td>
                <td className="num">
                  <span className={tone(a.value.pnlPct)}>{changeText(a.value.pnlPct)}</span>
                </td>
                <td className="num">{((a.value.cash / (a.value.total || 1)) * 100).toFixed(0)}%</td>
                <td className="num">{a.trades.length}</td>
                <td className="sub">{a.createdAt.slice(5, 10).replace('-', '/')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NewAccount({ x, done }: { x: View; done: (id?: string) => void }) {
  const [name, setName] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const managers = ids.filter((id) => x.ants.find((a) => a.id === id)?.role === 'manager').length;
  return (
    <section className="card" aria-labelledby="h-hn-new">
      <div className="card-head">
        <h2 id="h-hn-new">새 가상 계좌 (1천만 원)</h2>
        <span className="sub">개미를 골라 팀을 짭니다 · 최종 결정자 한 마리 꼭</span>
      </div>
      <div className="dr-form">
        <label className="dr-field">
          <span>이름</span>
          <input className="in" value={name} maxLength={20} placeholder="비우면 자동" onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <PickAnts ants={x.ants} value={ids} onChange={setIds} />
      {ids.length > 0 && managers !== 1 && <p className="o-warn">최종 결정자 역할의 개미를 한 마리 골라 주세요 (지금 {managers}마리).</p>}
      {msg && <p className="o-warn">{msg}</p>}
      <div className="em-form">
        <button
          type="button"
          className="btn pri"
          disabled={managers !== 1 || ids.length > 6}
          onClick={async () => {
            try {
              const r = await post<{ id: string }>('/api/harness', { name, ants: ids });
              done(r.id);
            } catch (e) {
              setMsg(`안 됨: ${e instanceof Error ? e.message : String(e)}`);
            }
          }}
        >
          만들기
        </button>
        <button type="button" className="btn" onClick={() => done()}>
          취소
        </button>
      </div>
    </section>
  );
}

/** 토론: 팀원 의견을 대화처럼 */
function Debate({ talk, block }: { talk: Say[]; block?: string[] }) {
  return (
    <ul className="hn-talk">
      {talk.map((s, i) => (
        <li key={i} className={`hn-say hn-${s.role}`}>
          {s.color !== undefined ? (
            <AntFace color={s.color} role={s.role} temper={s.temper} size={34} />
          ) : (
            <span className="hn-ava" aria-hidden="true">
              {s.name.slice(0, 1)}
            </span>
          )}
          <div>
            <b>{s.name}</b> <small className="sub">{s.temper === 'cons' ? '보수' : s.temper === 'aggr' ? '공격' : '중립'}</small>
            {s.stance && <small className="hn-stance">비중 {s.stance}</small>}
            <p>{s.text}</p>
            {s.picks.length > 0 && (
              <p className="hn-picks">
                {s.picks.map((p, k) => (
                  <span key={k}>
                    <b className={p.side === 'buy' ? 'up' : 'dn'}>{p.side === 'buy' ? '매수' : '매도'} {p.code}</b> {p.reason}
                  </span>
                ))}
              </p>
            )}
            {s.block.length > 0 && <p className="dn">반대(매수 금지): {s.block.join(', ')}</p>}
          </div>
        </li>
      ))}
      {block && block.length === 0 && <li className="sub">리스크 관리자가 반대한 종목 없음</li>}
    </ul>
  );
}

function AcctView({ a, x, reload, onAgent }: { a: Acct; x: View; reload: () => void; onAgent: (id: string) => void }) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const review = async () => {
    setReviewing(true);
    setMsg('채점하고 교훈을 고쳐 쓰는 중입니다…');
    try {
      const r = await post<{ reviewed: string[] }>(`/api/harness/${a.id}/review`, {});
      setMsg(r.reviewed.length ? `복기 끝: ${r.reviewed.join(', ')}` : '채점은 했지만 교훈을 고칠 만큼 판단이 쌓인 팀원이 없습니다 (5번부터)');
    } catch (e) {
      setMsg(`안 됨: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setReviewing(false);
      reload();
    }
  };
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
    const mins = Math.max(0, Math.round((last + a.limits.decideEveryMin * 60 - Date.now() / 1000) / 60));
    return `${MK[m]} 정규장 · 다음 판단 약 ${mins}분 뒤`;
  };
  return (
    <>
      <section className="summary" aria-label={`${a.name} 요약`}>
        <div className="sum-item">
          <span className="sum-k">개미 {a.team.length}마리 · 가상</span>
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
            {a.today.n}/{a.limits.maxTradesDay}번
          </b>
          <span className="sum-s">손절 포함</span>
        </div>
      </section>

      <section className="card" aria-labelledby={`h-ctl-${a.id}`}>
        <div className="card-head">
          <h2 id={`h-ctl-${a.id}`}>{a.team.length > 1 ? '개미 팀 하네스' : '개미 혼자 하네스'}</h2>
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
        {a.halted && <p className="o-warn">정지됨: {a.halted}. 다시 켜면 지금 값을 새 기준으로 삼습니다.</p>}
        {!x.ai && <p className="o-warn">AI 가 연결돼 있지 않아 판단하지 않습니다 (손절만 동작).</p>}
        {x.lastError && <p className="sub">마지막 오류: {x.lastError}</p>}
      </section>

      <TeamAnts aid={a.id} team={a.agents} ants={x.ants} catalog={x.catalog} onPick={onAgent} reload={reload} reviewing={reviewing} onReview={review} />
      <LimitsCard aid={a.id} limits={a.limits} hard={x.hard} haltPct={x.haltPct} log={a.limitLog} reload={reload} />

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
                {dc.debate && dc.debate.length > 0 && <Debate talk={dc.debate} block={dc.block} />}
                {dc.debateAt && <p className="sub">{dc.debateAt.slice(11, 16)} 팀 토론을 보고 최종 결정자가 다시 판단</p>}
                {dc.error ? <p className="o-warn">판단 실패: {dc.error}</p> : <p>{dc.manager ? <b>{dc.manager}: </b> : null}{dc.view || '(판단 글 없음)'}</p>}
                {dc.limits && dc.limits.length > 0 && (
                  <p className="hn-lim">
                    한도 바꿈: {dc.limits.join(', ')} {dc.limitsWhy && <span className="sub">· {dc.limitsWhy}</span>}
                  </p>
                )}
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
  return (
    <section className="card" aria-labelledby="h-hn-rules">
      <div className="card-head">
        <h2 id="h-hn-rules">하네스 규칙</h2>
      </div>
      <ul className="hn-rules">
        <li>판단: 계좌마다 국내·미국 정규장에서 장 시작 30분 뒤부터, AI 가 정한 주기로. 팀 계좌는 장마다 하루 한 번 팀 전체 토론</li>
        <li>한도(한 종목·한 번 매수·현금·하루 매매·손절·주기·투자 범위)는 AI 가 성적을 보고 스스로 정합니다. 바꿀 수 있는 폭은 정해 둠</li>
        <li>복기: 장 마감 보고 뒤 판단을 실제 가격으로 채점하고, 5번 넘게 채점된 팀원은 교훈을 스스로 고쳐 씁니다</li>
        <li>운용 본부: 매주 토요일 10:00 계좌 사이 돈 옮기기, 팀원 교체, 2주 넘은 꼴찌 계좌 해체와 새 팀 만들기</li>
        <li>코드가 강제하는 것: 계좌가 맡은 돈 대비 {x.haltPct}% 면 정지, 현금보다 많이 사지 않음(빚 없음), 리스크 관리자가 반대한 종목은 다음 토론까지 매수 금지, 비상 정지</li>
        <li>
          체결: 실제 한투 시세로 바로 체결한 것으로 계산. 수수료 국내 {(x.fees.kr * 100).toFixed(3)}%, 국내 매도 세금 {(x.fees.krTax * 100).toFixed(2)}%, 미국 {(x.fees.us * 100).toFixed(2)}% (환전 비용과 호가 차이는 빠짐)
        </li>
        <li>진짜 계좌 주문은 하지 않습니다. 보고: 국내 15:45, 미국 06:15 텔레그램</li>
      </ul>
    </section>
  );
}
