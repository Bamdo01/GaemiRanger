import { useEffect, useState } from 'react';
import { post, put } from './api';
import AntFace, { ANT_COLORS } from './AntFace';
import { edgeOf, type Call, type Lesson, type Stats } from './HarnessParts';
import { tone } from './lib';

// 개미 캐릭터 (2026-11-26): 도감, 만들기·고치기 (직접 또는 AI 로 채우기), 한 마리 보기, 계좌 팀 편집
export type AntSay = { at: string; market: 'kr' | 'us'; account: string; text: string; stance?: string; picks?: { side?: string; code?: string; reason?: string }[]; block?: string[]; orders?: string[]; results?: string[] };
export type Ant = {
  id: string;
  name: string;
  role: string;
  persona: string;
  temper: string;
  motto: string;
  philosophy: string;
  color: number;
  status: 'active' | 'rest';
  by: string;
  createdAt: string;
  reviewedAt?: string;
  title: string;
  lessons: Lesson[];
  log: { at: string; added: string[]; removed: string[]; note: string; hit?: number; n?: number }[];
  stats: Stats;
  teams: { id: string; name: string }[];
  calls: (Call & { account: string })[];
  says: AntSay[];
};
type Item = { name: string; desc: string };
export type AntCatalog = { roles: Record<string, Item>; personas: Record<string, Item>; tempers: Record<string, Item> };

const MK: Record<string, string> = { kr: '국내', us: '미국' };
const KIND: Record<string, string> = { buy: '사자', sell: '팔자', block: '매수 반대', stance: '비중' };
const t16 = (iso: string) => `${iso.slice(5, 10).replace('-', '/')} ${iso.slice(11, 16)}`;
const err = (e: unknown) => `안 됨: ${e instanceof Error ? e.message : String(e)}`;
const pct = (n?: number) => `${(n ?? 0) >= 0 ? '+' : ''}${(n ?? 0).toFixed(2)}%`;

function Score({ st }: { st: Stats }) {
  return st.n ? (
    <span className="sub">
      채점 {st.n}번 · 맞힘 {st.hit!.toFixed(0)}% · <span className={tone(st.avg ?? 0)}>{pct(st.avg)}</span>
    </span>
  ) : (
    <span className="sub">아직 채점 전</span>
  );
}

/** 개미 도감 */
export function AntDex({ ants, catalog, reload, onPick, ai }: { ants: Ant[]; catalog: AntCatalog; reload: () => void; onPick: (id: string) => void; ai: boolean }) {
  const [adding, setAdding] = useState(false);
  const [showRest, setShowRest] = useState(false);
  const list = ants.filter((a) => showRest || a.status === 'active');
  const restN = ants.filter((a) => a.status === 'rest').length;
  return (
    <>
      <section className="card" aria-labelledby="h-dex">
        <div className="card-head">
          <h2 id="h-dex">개미 도감 {ants.length - restN}마리</h2>
          <span className="sub">개미를 만들어 계좌 팀에 넣습니다 · 성적과 교훈은 개미를 따라다님</span>
          <span className="grow" />
          {restN > 0 && (
            <button type="button" className="btn sm" aria-pressed={showRest} onClick={() => setShowRest(!showRest)}>
              휴직 {restN} {showRest ? '숨기기' : '보기'}
            </button>
          )}
          <button type="button" className="btn sm pri" onClick={() => setAdding(!adding)} aria-expanded={adding}>
            ＋ 새 개미
          </button>
        </div>
        {adding && (
          <AntForm
            catalog={catalog}
            ai={ai}
            done={(id) => {
              setAdding(false);
              reload();
              if (id) onPick(id);
            }}
          />
        )}
        <ul className="dex">
          {list.map((a) => (
            <li key={a.id}>
              <button type="button" className={`dex-card ${a.status === 'rest' ? 'rest' : ''}`} onClick={() => onPick(a.id)}>
                <AntFace color={a.color} role={a.role} temper={a.temper} size={56} rest={a.status === 'rest'} />
                <b>{a.name}</b>
                <small className="sub">
                  {a.title} · {catalog.tempers[a.temper]?.name}
                </small>
                {a.motto && <small className="dex-motto">“{a.motto}”</small>}
                <Score st={a.stats} />
                <small className="sub">{a.status === 'rest' ? '휴직 중' : a.teams.length ? a.teams.map((t) => t.name).join(', ') : '소속 없음'}</small>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

type Draft = { name: string; role: string; persona: string; temper: string; motto: string; philosophy: string; color: number };

/** 개미 만들기·고치기. AI 로 채우기는 저장하지 않고 칸만 채운다 */
export function AntForm({ catalog, ai, ant, done }: { catalog: AntCatalog; ai: boolean; ant?: Ant; done: (id?: string) => void }) {
  const [f, setF] = useState<Draft>(ant ? { name: ant.name, role: ant.role, persona: ant.persona, temper: ant.temper, motto: ant.motto, philosophy: ant.philosophy, color: ant.color } : { name: '', role: 'analyst', persona: 'buffett', temper: 'mid', motto: '', philosophy: '', color: 0 });
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setF({ ...f, [k]: v });
  const sel = (k: 'role' | 'persona' | 'temper', list: Record<string, Item>, label: string) => (
    <label className="dr-field">
      <span>{label}</span>
      <select className="dd" value={f[k]} onChange={(e) => set(k, e.target.value)}>
        {Object.entries(list).map(([v, it]) => (
          <option key={v} value={v}>
            {it.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="ant-form">
      <div className="ant-form-top">
        <AntFace color={f.color} role={f.role} temper={f.temper} size={72} />
        <div className="ant-colors" role="radiogroup" aria-label="몸 색">
          {ANT_COLORS.map((c, i) => (
            <button key={c} type="button" role="radio" aria-checked={f.color === i} aria-label={`색 ${i + 1}`} style={{ background: c }} onClick={() => set('color', i)} />
          ))}
        </div>
      </div>
      {ai && (
        <div className="em-form ant-gen">
          <input className="in" value={hint} maxLength={300} placeholder="어떤 개미? 예: 배당주만 모으는 느긋한 개미" onChange={(e) => setHint(e.target.value)} aria-label="AI 에게 줄 개미 설명" />
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setMsg('');
              try {
                const d = await post<Draft>('/api/ants/generate', { hint });
                setF({ ...f, ...d });
                setMsg('AI 가 칸을 채웠습니다. 고친 뒤 저장하세요.');
              } catch (e) {
                setMsg(err(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '만드는 중…' : 'AI 로 채우기'}
          </button>
        </div>
      )}
      <div className="dr-form">
        <label className="dr-field">
          <span>이름</span>
          <input className="in" value={f.name} maxLength={12} placeholder="비우면 자동 (예: 버핏 개미)" onChange={(e) => set('name', e.target.value)} />
        </label>
        {sel('role', catalog.roles, '역할')}
        {sel('persona', catalog.personas, '투자관')}
        {sel('temper', catalog.tempers, '성향')}
        <label className="dr-field">
          <span>말버릇</span>
          <input className="in" value={f.motto} maxLength={60} placeholder="예: 싸게 사서 오래 간다" onChange={(e) => set('motto', e.target.value)} />
        </label>
      </div>
      <label className="dr-field ant-philo">
        <span>투자 철학 (선택, 300자) · 판단할 때 그대로 따릅니다</span>
        <textarea className="in" rows={3} maxLength={300} value={f.philosophy} placeholder="예: 배당을 10년 넘게 늘린 회사만 산다. 한 번 사면 1년은 판다고 하지 않는다." onChange={(e) => set('philosophy', e.target.value)} />
      </label>
      <p className="sub">
        {catalog.roles[f.role]?.desc} {catalog.personas[f.persona]?.desc}
      </p>
      {msg && <p className={msg.startsWith('안 됨') ? 'o-warn' : 'o-ok'}>{msg}</p>}
      <div className="em-form">
        <button
          type="button"
          className="btn pri"
          onClick={async () => {
            try {
              const r = ant ? await put<Ant>(`/api/ants/${ant.id}`, f) : await post<Ant>('/api/ants', f);
              done(r.id);
            } catch (e) {
              setMsg(err(e));
            }
          }}
        >
          {ant ? '저장' : '만들기'}
        </button>
        <button type="button" className="btn" onClick={() => done()}>
          취소
        </button>
      </div>
    </div>
  );
}

/** 개미 한 마리 */
export function AntView({ a, catalog, ai, back, reload }: { a: Ant; catalog: AntCatalog; ai: boolean; back: () => void; reload: () => void }) {
  const [tab, setTab] = useState<'calls' | 'says' | 'log'>('calls');
  const [edit, setEdit] = useState(false);
  const [msg, setMsg] = useState('');
  const st = a.stats;
  return (
    <section className="card ag-view" aria-labelledby="h-ant">
      <div className="card-head">
        <button type="button" className="btn sm" onClick={back}>
          ← 뒤로
        </button>
        <span className="grow" />
        <button type="button" className="btn sm" onClick={() => setEdit(!edit)} aria-expanded={edit}>
          고치기
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={async () => {
            setMsg('');
            try {
              await post(`/api/ants/${a.id}/status`, { status: a.status === 'rest' ? 'active' : 'rest' });
              reload();
            } catch (e) {
              setMsg(err(e));
            }
          }}
        >
          {a.status === 'rest' ? '복귀' : '휴직'}
        </button>
      </div>
      <div className="ant-hero">
        <AntFace color={a.color} role={a.role} temper={a.temper} size={88} rest={a.status === 'rest'} />
        <div>
          <h2 id="h-ant">
            {a.name} {a.status === 'rest' && <small className="sub">휴직 중</small>}
          </h2>
          <p className="sub">
            {a.title} · {catalog.tempers[a.temper]?.name} · {a.by === '본부' ? '운용 본부가 뽑음' : a.by === '기본' ? '처음부터 있던 개미' : '내가 만듦'}
          </p>
          {a.motto && <p className="dex-motto">“{a.motto}”</p>}
          <p className="sub">소속: {a.teams.length ? a.teams.map((t) => t.name).join(', ') : '없음'}</p>
        </div>
      </div>
      {msg && <p className="o-warn">{msg}</p>}
      {edit && (
        <AntForm
          catalog={catalog}
          ai={ai}
          ant={a}
          done={() => {
            setEdit(false);
            reload();
          }}
        />
      )}
      {a.philosophy && (
        <p className="ant-philo-view">
          <b>투자 철학</b> {a.philosophy}
        </p>
      )}
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
          <b className={`sum-v ${tone(st.avg ?? 0)}`}>{st.n ? pct(st.avg) : '–'}</b>
          <span className="sum-s">{st.best ? `최고 ${st.best.name || st.best.code} ${pct(st.best.edge)}` : '판단 방향 기준'}</span>
        </div>
      </div>
      <h3 className="ag-h">지금 지키는 교훈 {a.lessons.length}개</h3>
      {a.lessons.length === 0 ? (
        <p className="sub">아직 없습니다. 채점된 판단이 5번 쌓이면 장 마감 뒤 복기에서 스스로 씁니다.</p>
      ) : (
        <ol className="ag-lessons">
          {a.lessons.map((l) => (
            <li key={l.text}>
              {l.text} <small className="sub">{t16(l.at)}부터</small>
            </li>
          ))}
        </ol>
      )}
      <div className="seg ag-tabs" role="group" aria-label="볼 기록">
        {(
          [
            ['calls', `판단과 결과 ${a.calls.length}`],
            ['says', `발언 ${a.says.length}`],
            ['log', `복기 ${a.log.length}`],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'calls' &&
        (a.calls.length === 0 ? (
          <p className="sub">아직 채점할 판단이 없습니다.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>계좌</th>
                  <th>판단</th>
                  <th>종목</th>
                  <th className="num">그 뒤</th>
                  <th>결과</th>
                </tr>
              </thead>
              <tbody>
                {a.calls.map((c, i) => {
                  const e = edgeOf(c);
                  return (
                    <tr key={c.at + i}>
                      <td className="num">{t16(c.at)}</td>
                      <td className="sub">{c.account}</td>
                      <td>
                        {MK[c.mkt]} {KIND[c.kind]} {c.stance ?? ''}
                      </td>
                      <td>{c.name || c.code}</td>
                      <td className="num">{c.ret === null ? '–' : <span className={tone(c.ret)}>{pct(c.ret)}</span>}</td>
                      <td>{e === null ? <span className="sub">채점 전</span> : <span className={e > 0 ? 'up' : 'dn'}>{e > 0 ? '맞음' : '틀림'}{c.final ? '' : ' (진행 중)'}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      {tab === 'says' &&
        (a.says.length === 0 ? (
          <p className="sub">아직 발언이 없습니다.</p>
        ) : (
          <ul className="hn-log">
            {a.says.map((s, i) => (
              <li key={s.at + i}>
                <div className="hn-log-head">
                  <span className="num">{t16(s.at)}</span>
                  <span className="al-kind">{MK[s.market]}</span>
                  <span className="sub">{s.account}</span>
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
        (a.log.length === 0 ? (
          <p className="sub">아직 복기하지 않았습니다.</p>
        ) : (
          <ul className="hn-log">
            {a.log.map((l, i) => (
              <li key={l.at + i}>
                <div className="hn-log-head">
                  <span className="num">{t16(l.at)}</span>
                  {l.n !== undefined && (
                    <span className="sub">
                      채점 {l.n}번 · 맞힘 {l.hit}%
                    </span>
                  )}
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

/** 계좌 팀: 개미 얼굴 목록 + 편집 (개미 넣기·빼기) */
export function TeamAnts({ aid, team, ants, catalog, onPick, reload, reviewing, onReview }: { aid: string; team: string[]; ants: Ant[]; catalog: AntCatalog; onPick: (id: string) => void; reload: () => void; reviewing: boolean; onReview: () => void }) {
  const [edit, setEdit] = useState(false);
  const [ids, setIds] = useState<string[]>(team);
  const [msg, setMsg] = useState('');
  useEffect(() => setIds(team), [aid, team.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = (id: string) => ants.find((a) => a.id === id);
  const free = ants.filter((a) => a.status === 'active' && !ids.includes(a.id));
  const managers = ids.filter((id) => byId(id)?.role === 'manager').length;
  return (
    <section className="card" aria-labelledby={`h-team-${aid}`}>
      <div className="card-head">
        <h2 id={`h-team-${aid}`}>팀 개미 {team.length}마리</h2>
        <span className="sub">장마다 하루 한 번 모두 토론 · 그 뒤는 결정자만 · 누르면 그 개미</span>
        <span className="grow" />
        <button type="button" className="btn sm" disabled={reviewing} onClick={onReview}>
          {reviewing ? '복기하는 중…' : '지금 복기'}
        </button>
        <button type="button" className="btn sm" onClick={() => setEdit(!edit)} aria-expanded={edit}>
          {edit ? '닫기' : '팀 바꾸기'}
        </button>
      </div>
      <ul className="ag-list">
        {(edit ? ids : team).map((id) => {
          const a = byId(id);
          if (!a) return null;
          return (
            <li key={id} className="ag-li">
              <button type="button" className="ag-row" onClick={() => onPick(id)}>
                <AntFace color={a.color} role={a.role} temper={a.temper} size={40} />
                <span className="ag-main">
                  <b>{a.name}</b>
                  <small className="sub">
                    {a.title} · {catalog.tempers[a.temper]?.name} · 교훈 {a.lessons.length}개
                  </small>
                </span>
                <span className={`ag-score ${tone(a.stats.avg ?? 0)}`}>{a.stats.n ? pct(a.stats.avg) : '–'}</span>
              </button>
              {edit && (
                <button type="button" className="btn sm" onClick={() => setIds(ids.filter((x) => x !== id))} aria-label={`${a.name} 빼기`}>
                  빼기
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {edit && (
        <>
          <div className="em-form">
            <select
              className="dd"
              aria-label="넣을 개미"
              value=""
              disabled={ids.length >= 6 || free.length === 0}
              onChange={(e) => e.target.value && setIds([...ids, e.target.value])}
            >
              <option value="">{free.length ? '＋ 개미 넣기' : '넣을 개미 없음 (도감에서 만들기)'}</option>
              {free.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.title}
                </option>
              ))}
            </select>
            <span className="grow" />
            <button
              type="button"
              className="btn pri"
              disabled={managers !== 1 || ids.join() === team.join()}
              onClick={async () => {
                setMsg('');
                try {
                  await put(`/api/harness/${aid}/team`, { team: ids });
                  setMsg('저장했습니다. 다음 판단 때 새 팀이 토론합니다.');
                  setEdit(false);
                  reload();
                } catch (e) {
                  setMsg(err(e));
                }
              }}
            >
              팀 저장
            </button>
          </div>
          {managers !== 1 && <p className="o-warn">최종 결정자 역할의 개미가 꼭 한 마리 있어야 합니다 (지금 {managers}마리).</p>}
          <p className="sub">한 마리만 두면 토론 없이 그 개미 혼자 판단합니다. 최대 6마리.</p>
        </>
      )}
      {msg && <p className={msg.startsWith('안 됨') ? 'o-warn' : 'o-ok'}>{msg}</p>}
    </section>
  );
}

/** 새 계좌에 넣을 개미 고르기 */
export function PickAnts({ ants, value, onChange }: { ants: Ant[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <ul className="pick-ants">
      {ants
        .filter((a) => a.status === 'active')
        .map((a) => {
          const on = value.includes(a.id);
          return (
            <li key={a.id}>
              <button type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== a.id) : [...value, a.id])}>
                <AntFace color={a.color} role={a.role} temper={a.temper} size={32} />
                <span>
                  {a.name}
                  <small className="sub">{a.title}</small>
                </span>
              </button>
            </li>
          );
        })}
    </ul>
  );
}
