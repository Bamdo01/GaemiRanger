import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePoll } from './api';
import { changeText, fmt, signed, tone } from './lib';

// 내 자산 화면의 가상 계좌 (2026-11-25 사용자: 가상 계좌도 내 자산에서 보이게).
// 진짜 돈이 아니므로 총자산 합계에는 넣지 않고 따로 보여 준다. 누르면 하네스의 그 계좌로.
type PRow = { asset: 'kr' | 'us'; code: string; name: string; qty: number; amt: number; pnl: number; pnlPct: number; weight: number };
type PAcct = { id: string; name: string; strategy: string; teamN: number; enabled: boolean; halted: string; start: number; total: number; cash: number; pnl: number; pnlPct: number; rows: PRow[] };

export default function PaperCard() {
  const d = usePoll<{ accounts: PAcct[] }>('/api/harness/summary', 30_000, true);
  const [open, setOpen] = useState('');
  const list = d.data?.accounts ?? [];
  if (!list.length) return null;
  const total = list.reduce((s, a) => s + a.total, 0);
  const start = list.reduce((s, a) => s + a.start, 0);
  return (
    <section className="card paper-card" aria-labelledby="h-paper">
      <div className="card-head">
        <h2 id="h-paper">
          가상 계좌 <small className="sub">AI 가 굴리는 연습 돈 · 총자산에 안 들어감</small>
        </h2>
        <Link to="/harness" className="link">
          하네스 →
        </Link>
      </div>
      <p className="paper-sum">
        합계 <b>{fmt(total)}원</b> <span className={tone(total - start)}>{signed(total - start)}원 ({changeText(start ? (total / start - 1) * 100 : 0).replace(/^[▲▼] /, '')})</span>
      </p>
      <ul className="paper-list">
        {list.map((a) => {
          const isOpen = open === a.id;
          return (
            <li key={a.id}>
              <button type="button" className="paper-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '' : a.id)}>
                <span className="paper-tag">가상</span>
                <span className="paper-main">
                  <b>{a.name}</b>
                  <small className="sub">
                    {a.strategy === 'team' ? `팀 ${a.teamN}명` : 'AI 단독'} · 보유 {a.rows.length} · 현금 {((a.cash / (a.total || 1)) * 100).toFixed(0)}%{a.halted ? ' · 정지됨' : !a.enabled ? ' · 꺼짐' : ''}
                  </small>
                </span>
                <span className="paper-right">
                  <b>{fmt(a.total)}원</b>
                  <span className={tone(a.pnlPct)}>{changeText(a.pnlPct)}</span>
                </span>
              </button>
              {isOpen && (
                <div className="paper-more">
                  {a.rows.length === 0 ? (
                    <p className="sub">전부 현금입니다.</p>
                  ) : (
                    <ul>
                      {a.rows.map((r) => (
                        <li key={r.asset + r.code}>
                          <Link to={`/stock/${r.code}`}>{r.name}</Link>
                          <span className="sub">{r.weight.toFixed(1)}%</span>
                          <span className="num">{fmt(r.amt)}원</span>
                          <span className={tone(r.pnl)}>{changeText(r.pnlPct).replace(/^[▲▼] /, '')}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <Link to={`/harness?a=${a.id}`} className="btn sm">
                    이 계좌 하네스 보기
                  </Link>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
