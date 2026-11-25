import { useState } from 'react';
import { post, put } from './api';
import { fmt, tone } from './lib';

// 하네스 화면 조각 (2026-11-25): 팀원 한 명씩 보기, 한도(AI 가 스스로 정함), 운용 본부
export type Call = { at: string; who: string; mkt: 'kr' | 'us'; kind: 'buy' | 'sell' | 'block' | 'stance'; code: string; name?: string; price: number; stance?: string; ret: number | null; final: boolean };
export type Lesson = { text: string; at: string };
export type Stats = { n?: number; hit?: number; avg?: number; best?: { code: string; name?: string; kind: string; edge: number } | null; worst?: { code: string; name?: string; kind: string; edge: number } | null };
export type AgentSay = { at: string; market: 'kr' | 'us'; text: string; stance?: string; picks?: { side?: string; code?: string; reason?: string }[]; block?: string[]; orders?: string[]; results?: string[] };
export type Agent = { id: string; role: string; persona: string; temper: string; name: string; lessons: Lesson[]; log: { at: string; added: string[]; removed: string[]; note: string; hit?: number; n?: number }[]; stats: Stats; reviewedAt: string; calls: Call[]; says: AgentSay[] };
export type LimitsT = { maxPosPct: number; maxTradePct: number; maxTradesDay: number; minCashPct: number; stopPct: number; maxOrdersPerDecision: number; decideEveryMin: number; universe?: 'core' | 'wide' };
export type HqRun = { at: string; why: string; view: string; actions: string[]; real: string[]; error: string };
export type Hq = { runs: HqRun[]; retired: { at: string; name: string; team: string[]; pnlPct: number; reason: string }[]; next: string; running: boolean };

const MK: Record<string, string> = { kr: '국내', us: '미국' };
const KIND: Record<string, string> = { buy: '사자', sell: '팔자', block: '매수 반대', stance: '비중' };
const TEMPER: Record<string, string> = { cons: '보수', mid: '중립', aggr: '공격' };
const t16 = (iso: string) => `${iso.slice(5, 10).replace('-', '/')} ${iso.slice(11, 16)}`;
const err = (e: unknown) => `안 됨: ${e instanceof Error ? e.message : String(e)}`;

/** 판단 방향으로 본 수익률: 사자 → 오른 만큼, 팔자·반대 → 내린 만큼 */
export function edgeOf(c: Call): number | null {
  if (c.ret === null) return null;
  if (c.kind === 'buy') return c.ret;
  if (c.kind === 'sell' || c.kind === 'block') return -c.ret;
  const s = c.stance ?? '';
  return s.includes('늘') ? c.ret : s.includes('줄') ? -c.ret : 1.5 - Math.abs(c.ret);
}

/** 팀원 목록: 누르면 한 명씩 */
export function AgentsCard({ agents, onPick, reviewing, onReview }: { agents: Agent[]; onPick: (id: string) => void; reviewing: boolean; onReview: () => void }) {
  return (
    <section className="card" aria-labelledby="h-agents">
      <div className="card-head">
        <h2 id="h-agents">팀원 성적과 교훈</h2>
        <span className="sub">판단은 하루 뒤부터 실제 가격으로 채점 · 5번 넘으면 스스로 교훈을 고침</span>
        <span className="grow" />
        <button type="button" className="btn sm" disabled={reviewing} onClick={onReview}>
          {reviewing ? '복기하는 중…' : '지금 복기'}
        </button>
      </div>
      <ul className="ag-list">
        {agents.map((g) => (
          <li key={g.id}>
            <button type="button" className="ag-row" onClick={() => onPick(g.id)}>
              <span className="hn-ava" aria-hidden="true">
                {g.name.slice(0, 1)}
              </span>
              <span className="ag-main">
                <b>{g.name}</b> <small className="sub">{TEMPER[g.temper]}</small>
                <small className="sub">
                  {g.stats.n ? `채점 ${g.stats.n}번 · 맞힘 ${g.stats.hit!.toFixed(0)}% · ` : '아직 채점 전 · '}교훈 {g.lessons.length}개
                </small>
              </span>
              <span className={`ag-score ${tone(g.stats.avg ?? 0)}`}>{g.stats.n ? `${(g.stats.avg ?? 0) >= 0 ? '+' : ''}${(g.stats.avg ?? 0).toFixed(2)}%` : '–'}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 팀원 한 명 */
export function AgentView({ g, back }: { g: Agent; back: () => void }) {
  const [tab, setTab] = useState<'calls' | 'says' | 'log'>('calls');
  const st = g.stats;
  return (
    <section className="card ag-view" aria-labelledby="h-agent">
      <div className="card-head">
        <button type="button" className="btn sm" onClick={back}>
          ← 계좌로
        </button>
        <h2 id="h-agent">
          {g.name} <small className="sub">{TEMPER[g.temper]}</small>
        </h2>
      </div>
      <div className="summary ag-sum">
        <div className="sum-item">
          <span className="sum-k">채점된 판단</span>
          <b className="sum-v">{st.n ?? 0}번</b>
          <span className="sum-s">하루 뒤부터, 7일 뒤 굳음</span>
        </div>
        <div className="sum-item">
          <span className="sum-k">맞힌 비율</span>
          <b className="sum-v">{st.n ? `${st.hit!.toFixed(0)}%` : '–'}</b>
          <span className="sum-s">판단 방향으로 움직였는지</span>
        </div>
        <div className="sum-item">
          <span className="sum-k">평균 성과</span>
          <b className={`sum-v ${tone(st.avg ?? 0)}`}>{st.n ? `${(st.avg ?? 0) >= 0 ? '+' : ''}${(st.avg ?? 0).toFixed(2)}%` : '–'}</b>
          <span className="sum-s">
            {st.best ? `최고 ${st.best.name || st.best.code} ${st.best.edge >= 0 ? '+' : ''}${st.best.edge}%` : '판단 방향 기준'}
          </span>
        </div>
      </div>
      <h3 className="ag-h">지금 지키는 교훈 {g.lessons.length}개</h3>
      {g.lessons.length === 0 ? (
        <p className="sub">아직 없습니다. 채점된 판단이 5번 쌓이면 장 마감 뒤 복기에서 스스로 씁니다.</p>
      ) : (
        <ol className="ag-lessons">
          {g.lessons.map((l) => (
            <li key={l.text}>
              {l.text} <small className="sub">{t16(l.at)}부터</small>
            </li>
          ))}
        </ol>
      )}
      <div className="seg ag-tabs" role="group" aria-label="볼 기록">
        {(
          [
            ['calls', `판단과 결과 ${g.calls.length}`],
            ['says', `발언 ${g.says.length}`],
            ['log', `복기 ${g.log.length}`],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'calls' &&
        (g.calls.length === 0 ? (
          <p className="sub">아직 채점할 판단이 없습니다.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>판단</th>
                  <th>종목</th>
                  <th className="num">그 뒤</th>
                  <th>결과</th>
                </tr>
              </thead>
              <tbody>
                {g.calls.map((c, i) => {
                  const e = edgeOf(c);
                  return (
                    <tr key={c.at + i}>
                      <td className="num">{t16(c.at)}</td>
                      <td>
                        {MK[c.mkt]} {KIND[c.kind]} {c.stance ?? ''}
                      </td>
                      <td>{c.name || c.code}</td>
                      <td className="num">{c.ret === null ? '–' : <span className={tone(c.ret)}>{c.ret >= 0 ? '+' : ''}{c.ret.toFixed(2)}%</span>}</td>
                      <td>{e === null ? <span className="sub">채점 전</span> : <span className={e > 0 ? 'up' : 'dn'}>{e > 0 ? '맞음' : '틀림'}{c.final ? '' : ' (진행 중)'}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      {tab === 'says' &&
        (g.says.length === 0 ? (
          <p className="sub">아직 발언이 없습니다.</p>
        ) : (
          <ul className="hn-log">
            {g.says.map((s, i) => (
              <li key={s.at + i}>
                <div className="hn-log-head">
                  <span className="num">{t16(s.at)}</span>
                  <span className="al-kind">{MK[s.market]}</span>
                  {s.stance && <small className="hn-stance">비중 {s.stance}</small>}
                </div>
                <p>{s.text}</p>
                {s.picks && s.picks.length > 0 && (
                  <p className="hn-picks">
                    {s.picks.map((p, k) => (
                      <span key={k}>
                        <b className={p.side === 'buy' ? 'up' : 'dn'}>{p.side === 'buy' ? '매수' : '매도'} {p.code}</b> {p.reason}
                      </span>
                    ))}
                  </p>
                )}
                {s.block && s.block.length > 0 && <p className="dn">반대: {s.block.join(', ')}</p>}
                {s.orders && s.orders.length > 0 && (
                  <ul className="hn-orders">
                    {s.orders.map((o, k) => (
                      <li key={k}>
                        <b>{o}</b> <span className={s.results?.[k]?.startsWith('체결') ? 'up' : 'sub'}>{s.results?.[k]}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        ))}
      {tab === 'log' &&
        (g.log.length === 0 ? (
          <p className="sub">아직 복기하지 않았습니다.</p>
        ) : (
          <ul className="hn-log">
            {g.log.map((l, i) => (
              <li key={l.at + i}>
                <div className="hn-log-head">
                  <span className="num">{t16(l.at)}</span>
                  {l.n !== undefined && <span className="sub">채점 {l.n}번 · 맞힘 {l.hit}%</span>}
                </div>
                {l.note && <p>{l.note}</p>}
                {l.added.map((x) => (
                  <p key={'a' + x} className="up">
                    + {x}
                  </p>
                ))}
                {l.removed.map((x) => (
                  <p key={'r' + x} className="dn">
                    − {x}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}

const LNAME: [keyof LimitsT, string, string][] = [
  ['maxPosPct', '한 종목 최대', '%'],
  ['maxTradePct', '한 번 매수 최대', '%'],
  ['minCashPct', '현금 최소', '%'],
  ['maxTradesDay', '하루 매매', '번'],
  ['stopPct', '손절선', '%'],
  ['decideEveryMin', '판단 주기', '분'],
  ['maxOrdersPerDecision', '한 번에 주문', '개'],
];

/** 한도: AI 가 스스로 정하고, 사용자도 직접 바꿀 수 있다 */
export function LimitsCard({ aid, limits, hard, haltPct, log, reload }: { aid: string; limits: LimitsT; hard: Record<string, [number, number]>; haltPct: number; log: { at: string; by: string; changes: string[]; why: string }[]; reload: () => void }) {
  const [edit, setEdit] = useState<LimitsT | null>(null);
  const [msg, setMsg] = useState('');
  const cur = edit ?? limits;
  return (
    <section className="card" aria-labelledby={`h-lim-${aid}`}>
      <div className="card-head">
        <h2 id={`h-lim-${aid}`}>한도</h2>
        <span className="sub">AI 가 성적을 보고 스스로 바꿈 · 코드는 계좌 {haltPct}% 정지와 빚 금지만 강제</span>
        <span className="grow" />
        {edit ? (
          <>
            <button
              type="button"
              className="btn sm pri"
              onClick={async () => {
                try {
                  const r = await put<{ changes: string[] }>(`/api/harness/${aid}/limits`, { limits: edit });
                  setMsg(r.changes.length ? `바꿈: ${r.changes.join(', ')}` : '바뀐 것이 없습니다');
                  setEdit(null);
                  reload();
                } catch (e) {
                  setMsg(err(e));
                }
              }}
            >
              저장
            </button>
            <button type="button" className="btn sm" onClick={() => setEdit(null)}>
              취소
            </button>
          </>
        ) : (
          <button type="button" className="btn sm" onClick={() => setEdit({ ...limits })}>
            직접 바꾸기
          </button>
        )}
      </div>
      <dl className="lim-grid">
        {LNAME.map(([k, label, unit]) => (
          <div key={k}>
            <dt>{label}</dt>
            <dd>
              {edit ? (
                <input className="in" type="number" aria-label={label} min={hard[k]?.[0]} max={hard[k]?.[1]} value={cur[k] as number} onChange={(e) => setEdit({ ...cur, [k]: Number(e.target.value) })} />
              ) : (
                `${cur[k]}${unit}`
              )}
            </dd>
          </div>
        ))}
        <div>
          <dt>투자 범위</dt>
          <dd>
            {edit ? (
              <select className="dd" aria-label="투자 범위" value={cur.universe ?? 'core'} onChange={(e) => setEdit({ ...cur, universe: e.target.value as 'core' | 'wide' })}>
                <option value="core">좁음 (지수 구성종목·지정 ETF)</option>
                <option value="wide">넓음 (아무 종목, 레버리지 포함)</option>
              </select>
            ) : cur.universe === 'wide' ? (
              '넓음 (레버리지 포함)'
            ) : (
              '좁음 (지수 종목)'
            )}
          </dd>
        </div>
      </dl>
      {msg && <p className={msg.startsWith('안 됨') ? 'o-warn' : 'o-ok'}>{msg}</p>}
      {log.length > 0 && (
        <ul className="hn-rules">
          {log.slice(0, 6).map((l, i) => (
            <li key={l.at + i}>
              <span className="num">{t16(l.at)}</span> <b>{l.by}</b>: {l.changes.join(', ')} {l.why && <span className="sub">· {l.why}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 운용 본부: 매주 계좌 사이 돈 나누기, 팀 교체, 실계좌 조언 */
export function HqCard({ hq, accounts, ai, reload }: { hq: Hq; accounts: { id: string; name: string; cash: number }[]; ai: boolean; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [mv, setMv] = useState({ src: accounts[0]?.id ?? '', dst: accounts[1]?.id ?? '', amount: '' });
  const last = hq.runs[0];
  return (
    <section className="card" aria-labelledby="h-hq">
      <div className="card-head">
        <h2 id="h-hq">운용 본부</h2>
        <span className="sub">매주 토요일 10:00 · 다음 {t16(hq.next)}</span>
        <span className="grow" />
        <button
          type="button"
          className="btn sm"
          disabled={busy || hq.running || !ai}
          onClick={async () => {
            setBusy(true);
            setMsg('본부가 계좌들을 보는 중입니다… (1분쯤)');
            try {
              const r = await post<HqRun>('/api/harness/hq/run', {});
              setMsg(r.error ? `실패: ${r.error}` : '끝났습니다');
            } catch (e) {
              setMsg(err(e));
            } finally {
              setBusy(false);
              reload();
            }
          }}
        >
          {busy ? '보는 중…' : '지금 실행'}
        </button>
      </div>
      <p className="sub">잘하는 팀에 돈을 더 맡기고, 성적 나쁜 팀원은 바꾸고, 2주 넘은 꼴찌 계좌는 해체한 뒤 새 팀을 만듭니다. 실제 계좌는 조언만 합니다.</p>
      {msg && <p className={msg.startsWith('안 됨') || msg.startsWith('실패') ? 'o-warn' : 'o-ok'}>{msg}</p>}
      {!last ? (
        <p className="sub">아직 실행한 적이 없습니다.</p>
      ) : (
        <ul className="hn-log">
          {hq.runs.slice(0, 4).map((r, i) => (
            <li key={r.at + i}>
              <div className="hn-log-head">
                <span className="num">{t16(r.at)}</span>
                {r.why !== '정기' && <span className="sub">{r.why}</span>}
              </div>
              {r.error ? <p className="o-warn">{r.error}</p> : <p>{r.view}</p>}
              {r.actions.length > 0 ? (
                <ul className="hn-orders">
                  {r.actions.map((x, k) => (
                    <li key={k} className={x.startsWith('거절') ? 'sub' : undefined}>
                      {x}
                    </li>
                  ))}
                </ul>
              ) : (
                !r.error && <p className="sub">바꾼 것 없음</p>
              )}
              {r.real.length > 0 && (
                <div className="hq-real">
                  <b>실제 계좌 조언</b>
                  <ul>
                    {r.real.map((x, k) => (
                      <li key={k}>{x}</li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {hq.retired.length > 0 && (
        <p className="sub">
          해체한 계좌: {hq.retired.map((r) => `${r.name} (${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct}%)`).join(', ')}
        </p>
      )}
      {accounts.length > 1 && (
        <div className="em-form hq-move">
          <span className="sub">직접 옮기기</span>
          <select className="dd" aria-label="보내는 계좌" value={mv.src} onChange={(e) => setMv({ ...mv, src: e.target.value })}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} (현금 {fmt(a.cash)})
              </option>
            ))}
          </select>
          →
          <select className="dd" aria-label="받는 계좌" value={mv.dst} onChange={(e) => setMv({ ...mv, dst: e.target.value })}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <input className="in" type="number" inputMode="numeric" aria-label="옮길 금액(원)" placeholder="금액(원)" value={mv.amount} onChange={(e) => setMv({ ...mv, amount: e.target.value })} />
          <button
            type="button"
            className="btn sm"
            disabled={!mv.amount || mv.src === mv.dst}
            onClick={async () => {
              try {
                const r = await post<{ result: string }>('/api/harness/transfer', { src: mv.src, dst: mv.dst, amount: Number(mv.amount) });
                setMsg(r.result);
                setMv({ ...mv, amount: '' });
                reload();
              } catch (e) {
                setMsg(err(e));
              }
            }}
          >
            옮기기
          </button>
        </div>
      )}
    </section>
  );
}

