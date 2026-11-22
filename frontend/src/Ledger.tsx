import { useEffect, useState } from 'react';
import { del, post, put, refreshAll, usePoll } from './api';
import { fmt } from './lib';

// 수기 자산: 계좌 · 환율 · 직접 넣는 현재가 · 거래 기록 (2026-11-22 사용자: 연동 안 되는 자산도 한 포트폴리오로, 거래 기록 단위)
type Account = { id: string; name: string };
type Rec = {
  id: string;
  kind: Kind;
  date: string;
  account: string;
  asset: string;
  symbol: string;
  name: string;
  qty: number;
  price: number;
  fee: number;
  amount: number;
  currency: string;
  memo: string;
};
type Manual = { key: string; name: string; asset: string; currency: string; price: number | null; last: number };
type View = { accounts: Account[]; records: Rec[]; fx: number; fxDefault: boolean; manual: Manual[]; assets: Record<string, string> };
type Kind = 'buy' | 'sell' | 'div' | 'value';

const KINDS: [Kind, string][] = [
  ['buy', '매수'],
  ['sell', '매도'],
  ['div', '배당·이자'],
  ['value', '금액 평가'],
];
const TRADE: [string, string][] = [
  ['kr', '국내주식'],
  ['us', '해외주식'],
  ['coin', '코인'],
];
const VALUE: [string, string][] = [
  ['cash', '예금·현금'],
  ['etc', '기타 (부동산 등)'],
];
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const num = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 8 });
const money = (n: number, cur: string) => (cur === 'USD' ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 4 })}` : `${fmt(n)}원`);

type Form = { kind: Kind; date: string; account: string; asset: string; symbol: string; name: string; qty: string; price: string; fee: string; amount: string; currency: string };
const blank = (account = ''): Form => ({ kind: 'buy', date: today(), account, asset: 'kr', symbol: '', name: '', qty: '', price: '', fee: '', amount: '', currency: 'KRW' });

export default function Ledger() {
  const srv = usePoll<View>('/api/ledger', 60_000);
  const v = srv.data;
  const [form, setForm] = useState<Form>(blank());
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('all');

  // 계좌가 생기면 폼의 계좌를 첫 계좌로
  useEffect(() => {
    if (v && !v.accounts.some((a) => a.id === form.account)) setForm((f) => ({ ...f, account: v.accounts[0]?.id ?? '' }));
  }, [v, form.account]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
      refreshAll();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!v) return <section className="card">{srv.error ? <p className="o-warn">거래 기록을 불러오지 못했습니다: {srv.error}</p> : <p className="sub">거래 기록을 불러오는 중…</p>}</section>;

  const set = (k: keyof Form, val: string) =>
    setForm((f) => {
      const n = { ...f, [k]: val };
      if (k === 'kind') n.asset = val === 'value' ? 'cash' : val === 'div' ? f.asset : TRADE.some(([a]) => a === f.asset) ? f.asset : 'kr';
      if (k === 'asset') n.currency = val === 'us' ? 'USD' : 'KRW';
      return n;
    });
  const trade = form.kind === 'buy' || form.kind === 'sell';
  const submit = async () => {
    const body = {
      kind: form.kind,
      date: form.date,
      account: form.account,
      asset: form.asset,
      symbol: form.symbol,
      name: form.name,
      qty: Number(form.qty) || 0,
      price: Number(form.price) || 0,
      fee: Number(form.fee) || 0,
      amount: Number(form.amount) || 0,
      currency: form.currency,
    };
    const ok = await run(() => (editing ? put(`/api/ledger/records/${editing}`, body) : post('/api/ledger/records', body)));
    if (ok) {
      setEditing(null);
      setForm({ ...blank(form.account), kind: form.kind, asset: form.asset, currency: form.currency, date: form.date });
    }
  };
  const startEdit = (r: Rec) => {
    setEditing(r.id);
    setErr('');
    setForm({
      kind: r.kind,
      date: r.date,
      account: r.account,
      asset: r.asset || 'kr',
      symbol: r.symbol,
      name: r.name,
      qty: r.qty ? String(r.qty) : '',
      price: r.price ? String(r.price) : '',
      fee: r.fee ? String(r.fee) : '',
      amount: r.amount ? String(r.amount) : '',
      currency: r.currency,
    });
  };
  const acctName = (id: string) => v.accounts.find((a) => a.id === id)?.name ?? id;
  const records = v.records.filter((r) => filter === 'all' || r.account === filter);
  const kindLabel = (k: Kind) => KINDS.find(([x]) => x === k)?.[1] ?? k;

  return (
    <section className="card ledger" aria-labelledby="h-ledger">
      <div className="card-head">
        <h2 id="h-ledger">거래 기록 (수기 계좌)</h2>
        <span className="sub">한투와 연동되지 않는 자산을 넣으면 위 합계에 같이 들어갑니다</span>
      </div>

      <Accounts v={v} run={run} busy={busy} />

      {v.accounts.length > 0 && (
        <>
          <div className="lg-row">
            <FxBox v={v} run={run} busy={busy} />
            {v.manual.length > 0 && <ManualPrices v={v} run={run} busy={busy} />}
          </div>

          <form
            className="lg-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <h3>{editing ? '기록 고치기' : '기록 추가'}</h3>
            <div className="lg-fields">
              <Field label="종류">
                <select className="in" value={form.kind} onChange={(e) => set('kind', e.target.value)}>
                  {KINDS.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="날짜">
                <input className="in" type="date" value={form.date} max={today()} onChange={(e) => set('date', e.target.value)} />
              </Field>
              <Field label="계좌">
                <select className="in" value={form.account} onChange={(e) => set('account', e.target.value)}>
                  {v.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              {form.kind !== 'div' && (
                <Field label="자산 종류">
                  <select className="in" value={form.asset} onChange={(e) => set('asset', e.target.value)}>
                    {(form.kind === 'value' ? VALUE : TRADE).map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {trade && (
                <Field label={form.asset === 'kr' ? '종목코드 (6자리)' : '티커 (예: AAPL, BTC)'}>
                  <input className="in" value={form.symbol} onChange={(e) => set('symbol', e.target.value)} placeholder={form.asset === 'kr' ? '005930' : form.asset === 'us' ? 'AAPL' : 'BTC'} />
                </Field>
              )}
              <Field label={form.kind === 'value' ? '이름 (예: 예금, 전세보증금)' : form.asset === 'kr' && trade ? '이름 (비우면 자동)' : '이름'}>
                <input className="in" value={form.name} onChange={(e) => set('name', e.target.value)} />
              </Field>
              {trade ? (
                <>
                  <Field label="수량">
                    <input className="in" inputMode="decimal" value={form.qty} onChange={(e) => set('qty', e.target.value)} />
                  </Field>
                  <Field label="단가">
                    <input className="in" inputMode="decimal" value={form.price} onChange={(e) => set('price', e.target.value)} />
                  </Field>
                  <Field label="수수료·세금">
                    <input className="in" inputMode="decimal" value={form.fee} onChange={(e) => set('fee', e.target.value)} placeholder="0" />
                  </Field>
                </>
              ) : (
                <Field label={form.kind === 'value' ? '지금 금액' : '받은 금액'}>
                  <input className="in" inputMode="decimal" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
                </Field>
              )}
              {form.asset !== 'kr' && (
                <Field label="통화">
                  <select className="in" value={form.currency} onChange={(e) => set('currency', e.target.value)}>
                    <option value="KRW">원</option>
                    <option value="USD">달러</option>
                  </select>
                </Field>
              )}
            </div>
            {trade && form.qty && form.price && (
              <p className="sub">
                {kindLabel(form.kind)} 금액 {money((Number(form.qty) || 0) * (Number(form.price) || 0), form.currency)}
              </p>
            )}
            {err && (
              <p className="o-warn" role="alert">
                {err}
              </p>
            )}
            <div className="lg-actions">
              <button type="submit" className="btn pri" disabled={busy}>
                {editing ? '고친 것 저장' : '추가'}
              </button>
              {editing && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setEditing(null);
                    setForm(blank(form.account));
                    setErr('');
                  }}
                >
                  취소
                </button>
              )}
            </div>
          </form>

          <div className="card-head lg-list-head">
            <h3>기록 {records.length}개</h3>
            <select className="dd" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="기록 계좌 고르기">
              <option value="all">전체 계좌</option>
              {v.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          {records.length === 0 ? (
            <p className="sub">아직 기록이 없습니다. 이미 가진 자산은 산 날짜로 "매수" 한 줄을 넣고 시작하면 됩니다.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">날짜</th>
                    <th scope="col">계좌</th>
                    <th scope="col">종류</th>
                    <th scope="col">자산</th>
                    <th scope="col" className="num">
                      수량
                    </th>
                    <th scope="col" className="num">
                      단가 / 금액
                    </th>
                    <th scope="col" className="num">
                      수수료
                    </th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.id} className={editing === r.id ? 'editing' : undefined}>
                      <td>{r.date}</td>
                      <td>{acctName(r.account)}</td>
                      <td>{kindLabel(r.kind)}</td>
                      <td>
                        {r.name}
                        {r.symbol && r.symbol !== r.name && <small className="sub"> {r.symbol}</small>}
                      </td>
                      <td className="num">{r.qty ? num(r.qty) : '-'}</td>
                      <td className="num">{r.kind === 'buy' || r.kind === 'sell' ? money(r.price, r.currency) : money(r.amount, r.currency)}</td>
                      <td className="num">{r.fee ? money(r.fee, r.currency) : '-'}</td>
                      <td className="num lg-btns">
                        <button type="button" className="btn sm" onClick={() => startEdit(r)}>
                          고치기
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(`${r.date} ${kindLabel(r.kind)} ${r.name} 기록을 지울까요?`)) run(() => del(`/api/ledger/records/${r.id}`));
                          }}
                        >
                          지우기
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="lg-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

type Run = (fn: () => Promise<unknown>) => Promise<boolean>;

function Accounts({ v, run, busy }: { v: View; run: Run; busy: boolean }) {
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="lg-accts">
      <span className="sub">수기 계좌</span>
      {v.accounts.length === 0 && <span className="sub">아직 없습니다. 먼저 계좌를 하나 만드세요 (예: 키움, 업비트, 은행).</span>}
      {v.accounts.map((a) =>
        renaming?.id === a.id ? (
          <form
            key={a.id}
            className="lg-chip"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run(() => put(`/api/ledger/accounts/${a.id}`, { name: renaming.name }))) setRenaming(null);
            }}
          >
            <input className="in sm" value={renaming.name} onChange={(e) => setRenaming({ id: a.id, name: e.target.value })} aria-label="새 계좌 이름" autoFocus />
            <button type="submit" className="btn sm" disabled={busy}>
              저장
            </button>
            <button type="button" className="btn sm" onClick={() => setRenaming(null)}>
              취소
            </button>
          </form>
        ) : (
          <span key={a.id} className="lg-chip">
            {a.name}
            <button type="button" className="link" onClick={() => setRenaming({ id: a.id, name: a.name })}>
              이름 바꾸기
            </button>
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`계좌 "${a.name}"을 지울까요? (기록이 있으면 지워지지 않습니다)`)) run(() => del(`/api/ledger/accounts/${a.id}`));
              }}
            >
              지우기
            </button>
          </span>
        ),
      )}
      <form
        className="lg-chip"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => post('/api/ledger/accounts', { name }))) setName('');
        }}
      >
        <input className="in sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="새 계좌 이름" aria-label="새 계좌 이름" />
        <button type="submit" className="btn sm" disabled={busy || !name.trim()}>
          계좌 추가
        </button>
      </form>
    </div>
  );
}

function FxBox({ v, run, busy }: { v: View; run: Run; busy: boolean }) {
  const [val, setVal] = useState(String(v.fx));
  useEffect(() => setVal(String(v.fx)), [v.fx]);
  return (
    <form
      className="lg-box"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => put('/api/ledger/fx', { value: Number(val) }));
      }}
    >
      <span className="sub">환율 {v.fxDefault && '(아직 안 넣음, 기본값)'}</span>
      <span className="lg-inline">
        1달러 =
        <input className="in sm" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} aria-label="원/달러 환율" />원
        <button type="submit" className="btn sm" disabled={busy}>
          저장
        </button>
      </span>
    </form>
  );
}

function ManualPrices({ v, run, busy }: { v: View; run: Run; busy: boolean }) {
  return (
    <div className="lg-box">
      <span className="sub">직접 넣는 현재가 (해외주식·코인, 안 넣으면 마지막 거래 단가)</span>
      {v.manual.map((m) => (
        <PriceRow key={m.key} m={m} run={run} busy={busy} />
      ))}
    </div>
  );
}

function PriceRow({ m, run, busy }: { m: Manual; run: Run; busy: boolean }) {
  const [val, setVal] = useState(String(m.price ?? m.last));
  useEffect(() => setVal(String(m.price ?? m.last)), [m.price, m.last]);
  return (
    <form
      className="lg-inline"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => put('/api/ledger/price', { key: m.key, price: Number(val) }));
      }}
    >
      <b>{m.name}</b>
      <input className="in sm" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} aria-label={`${m.name} 현재가`} />
      {m.currency === 'USD' ? '달러' : '원'}
      <button type="submit" className="btn sm" disabled={busy}>
        저장
      </button>
      {m.price === null && <span className="sub">마지막 거래 단가 사용 중</span>}
    </form>
  );
}
