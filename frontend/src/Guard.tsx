import { useState } from 'react';
import { post, put, usePoll, useServer } from './api';

// 자산 지킴이 기준 (설정 화면). 텔레그램으로도 묻지만, 여기서 직접 정할 수도 있다 (AI·텔레그램 없이 되는 길).
type Crit = { value: string; label: string; temp: boolean; title: string };
type View = {
  criteria: Record<string, Crit>;
  questions: Record<string, { title: string; ask: string; options: [string, string][] }>;
  risks: string[];
  rebalance: string[];
  alloc: Record<string, number> | null;
  target: Record<string, number>;
  peak: { value: number; at: string };
};

export function GuardSettings() {
  const { live } = useServer();
  const [v, setV] = useState(0);
  const g = usePoll<View>(live ? `/api/guard?v=${v}` : null, 60_000);
  const [msg, setMsg] = useState('');
  const d = g.data;
  if (!d) return null;
  const temp = Object.values(d.criteria).filter((c) => c.temp).length;
  return (
    <section className="card" id="guard" aria-labelledby="h-guard">
      <div className="card-head">
        <h2 id="h-guard">자산 지킴이 기준</h2>
        <span className="sub">{temp ? `${temp}개 아직 안 정함 · 지금은 추천안으로 지킴` : '모두 정함'}</span>
      </div>
      <div className="dr-form">
        {Object.entries(d.questions).map(([k, q]) => (
          <label key={k} className="dr-field">
            <span>
              {q.title} {d.criteria[k].temp && <small className="dn">(임시)</small>}
            </span>
            <select
              className="dd"
              value={d.criteria[k].temp ? '' : d.criteria[k].value}
              onChange={async (e) => {
                setMsg('');
                try {
                  await put('/api/guard', { key: k, value: e.target.value });
                  setV(v + 1);
                  setMsg(`${q.title}을(를) 저장했습니다`);
                } catch (e2) {
                  setMsg(`안 됨: ${e2 instanceof Error ? e2.message : String(e2)}`);
                }
              }}
            >
              {d.criteria[k].temp && <option value="">정하기 (추천: {q.options[0][1]})</option>}
              {q.options.map(([val, label], i) => (
                <option key={val} value={val}>
                  {label}
                  {i === 0 ? ' (추천)' : ''}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {d.risks.length > 0 && (
        <>
          <p className="sub" style={{ marginBottom: 4 }}>
            지금 걸리는 위험
          </p>
          <ul className="guard-risks">
            {d.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
      {d.rebalance.length > 0 && (
        <>
          <p className="sub" style={{ marginBottom: 4 }}>
            리밸런싱 (목표 기준 계산, 판단은 직접)
          </p>
          <ul className="guard-risks">
            {d.rebalance.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
      {msg && <p className={msg.startsWith('안 됨') ? 'o-warn' : 'o-ok'}>{msg}</p>}
      {temp > 0 && (
        <button
          type="button"
          className="btn"
          onClick={async () => {
            setMsg('');
            try {
              const r = await post<{ sent: boolean }>('/api/guard/ask', {});
              setMsg(r.sent ? '텔레그램으로 보냈습니다' : '보내지 못했습니다 (텔레그램 미연결이거나 자산을 아직 못 불러옴)');
            } catch (e2) {
              setMsg(`안 됨: ${e2 instanceof Error ? e2.message : String(e2)}`);
            }
          }}
        >
          텔레그램으로 지금 묻기
        </button>
      )}
      <p className="sub">텔레그램 봇에게 /점검, /종목 삼성전자, /기준 을 보내거나 그냥 말을 걸 수 있습니다. 주문은 하지 않습니다.</p>
    </section>
  );
}
