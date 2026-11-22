import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { usePoll, useServer } from './api';

// 기록 (L1 활동 기록, L2 규칙 발동): 주문·규칙·수기 기록·설정·로그인을 한 줄로. 누가(화면·규칙·IP) 했는지 함께
type Item = { at: string; type: string; text: string; by: string; result: string; detail: string; code?: string };
type Res = { items: Item[]; today: { orders: number; refused: number; rules: number; logins: number } };

const TYPES: [string, string][] = [
  ['all', '전체'],
  ['order', '주문'],
  ['rule', '규칙'],
  ['ledger', '수기 기록'],
  ['setting', '설정'],
  ['login', '로그인'],
];
const DAYS: [string, string][] = [
  ['1', '오늘'],
  ['7', '1주'],
  ['30', '1달'],
  ['90', '3달'],
];
const TYPE_NAME = Object.fromEntries(TYPES) as Record<string, string>;
const BAD = ['거절', '실패', '확인 시간 지남'];
const GOOD = ['접수', '성공', '완료'];

export default function LogPage() {
  const { live } = useServer();
  const [sp, setSp] = useSearchParams();
  const type = TYPES.some(([k]) => k === sp.get('type')) ? sp.get('type')! : 'all';
  const days = DAYS.some(([k]) => k === sp.get('days')) ? sp.get('days')! : '7';
  const [q, setQ] = useState('');
  const set = (k: string, v: string, def: string) => {
    const n = new URLSearchParams(sp);
    if (v === def) n.delete(k);
    else n.set(k, v);
    setSp(n, { replace: true });
  };
  const srv = usePoll<Res>(live ? `/api/log?days=${days}` : null, 10_000, true);
  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (srv.data?.items ?? []).filter((x) => (type === 'all' || x.type === type) && (!t || `${x.text} ${x.detail} ${x.by}`.toLowerCase().includes(t)));
  }, [srv.data, type, q]);
  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>();
    items.forEach((x) => {
      const d = x.at.slice(0, 10);
      m.set(d, [...(m.get(d) ?? []), x]);
    });
    return [...m];
  }, [items]);

  if (!live)
    return (
      <div className="soon">
        <h1>기록</h1>
        <p>기록은 서버에 남습니다. 서버에 연결해 로그인하면 보입니다.</p>
      </div>
    );
  const t = srv.data?.today;
  return (
    <div className="orders logs">
      <section className="summary" aria-label="오늘 요약">
        <Chip k="오늘 주문 접수" v={t ? `${t.orders}건` : '-'} onClick={() => set('type', 'order', 'all')} />
        <Chip k="오늘 주문 거절" v={t ? `${t.refused}건` : '-'} warn={!!t?.refused} onClick={() => setQ('거절')} />
        <Chip k="오늘 규칙 발동" v={t ? `${t.rules}번` : '-'} onClick={() => set('type', 'rule', 'all')} />
        <Chip k="오늘 로그인" v={t ? `${t.logins}번` : '-'} onClick={() => set('type', 'login', 'all')} />
      </section>

      <section className="card">
        <div className="card-head lg-filters">
          <div className="seg" role="group" aria-label="종류">
            {TYPES.map(([k, l]) => (
              <button key={k} type="button" aria-pressed={type === k} onClick={() => set('type', k, 'all')}>
                {l}
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="기간">
            {DAYS.map(([k, l]) => (
              <button key={k} type="button" aria-pressed={days === k} onClick={() => set('days', k, '7')}>
                {l}
              </button>
            ))}
          </div>
          <input className="in log-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="찾기 (종목, 거절, IP …)" aria-label="기록에서 찾기" />
        </div>
        {srv.error && <p className="o-warn">기록을 불러오지 못했습니다: {srv.error}</p>}
        {!srv.data ? (
          <p className="sub">불러오는 중…</p>
        ) : items.length === 0 ? (
          <p className="sub">이 조건에 맞는 기록이 없습니다.</p>
        ) : (
          byDay.map(([d, list]) => (
            <div key={d} className="log-day">
              <h3>{d}</h3>
              <ul className="log-list">
                {list.map((x, i) => (
                  <li key={`${x.at}-${i}`}>
                    <span className="log-time num">{x.at.slice(11, 19)}</span>
                    <span className={`log-type lt-${x.type}`}>{TYPE_NAME[x.type] ?? x.type}</span>
                    <span className="log-text">
                      {x.text}
                      {x.code && /^[0-9][0-9A-Z]{5}$/.test(x.code) && (
                        <>
                          {' '}
                          <Link to={`/stock/${x.code}`} className="link">
                            종목
                          </Link>
                        </>
                      )}
                      {x.detail && <small className="sub"> · {x.detail}</small>}
                    </span>
                    <span className="log-by sub">{x.by}</span>
                    {x.result && <span className={`st ${BAD.some((b) => x.result.includes(b)) ? 'st-bad' : GOOD.some((g) => x.result.includes(g)) ? 'st-good' : ''}`}>{x.result}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
        <p className="sub">주문 시도(거절 포함), 정정·취소, 규칙 발동, 수기 기록 변경, 설정 변경, 로그인이 남습니다. 최근 1,000건까지 보여 줍니다.</p>
      </section>
    </div>
  );
}

function Chip({ k, v, warn, onClick }: { k: string; v: string; warn?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="sum-item sum-link" onClick={onClick}>
      <span className="sum-k">{k}</span>
      <b className={`sum-v${warn ? ' warn-text' : ''}`}>{v}</b>
    </button>
  );
}
