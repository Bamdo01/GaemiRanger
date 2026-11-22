import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { del, post, put, refreshAll, usePoll } from './api';
import { fmt } from './lib';

// 기록 서랍: 내 자산 위쪽 [＋ 기록] 또는 표의 [＋]로 오른쪽에서 연다. 뒤의 히트맵·합계는 그대로 보이고 저장하면 바로 바뀐다.
// (2026-11-22 사용자: 맨 아래 입력 칸은 불편. 사용자 편의 우선)
type Account = { id: string; name: string };
type Kind = 'buy' | 'sell' | 'div' | 'value';
type Rec = { id: string; kind: Kind; date: string; account: string; asset: string; symbol: string; name: string; qty: number; price: number; fee: number; amount: number; currency: string };
type View = { accounts: Account[]; records: Rec[] };
export type Tab = 'new' | 'list' | 'accounts';
export type Prefill = { kind?: Kind; account?: string; asset?: string; symbol?: string; name?: string; tab?: Tab };
export type Candidate = { code: string; name: string };

const KINDS: [Kind, string][] = [
  ['buy', '매수'],
  ['sell', '매도'],
  ['div', '배당·이자'],
  ['value', '금액'],
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
const kindLabel = (k: Kind) => KINDS.find(([x]) => x === k)?.[1] ?? k;

type Form = { kind: Kind; date: string; account: string; asset: string; symbol: string; name: string; qty: string; price: string; fee: string; amount: string; currency: string };
const blank = (account = ''): Form => ({ kind: 'buy', date: today(), account, asset: 'kr', symbol: '', name: '', qty: '', price: '', fee: '', amount: '', currency: 'KRW' });

export default function LedgerDrawer({ open, prefill, onClose, candidates }: { open: boolean; prefill: Prefill | null; onClose: () => void; candidates: Candidate[] }) {
  const srv = usePoll<View>(open ? '/api/ledger' : null, 60_000);
  const v = srv.data;
  const [tab, setTab] = useState<Tab>('new');
  const [form, setForm] = useState<Form>(blank());
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLElement>(null);

  // 열 때 미리 채울 값 (표의 [＋] 에서 온 종목·계좌)
  useEffect(() => {
    if (!open) return;
    setErr('');
    setEditing(null);
    setTab(prefill?.tab ?? 'new');
    setForm((f) => ({ ...blank(prefill?.account ?? f.account), kind: prefill?.kind ?? 'buy', asset: prefill?.asset ?? 'kr', symbol: prefill?.symbol ?? '', name: prefill?.name ?? '', currency: prefill?.asset === 'us' ? 'USD' : 'KRW' }));
    panel.current?.focus();
  }, [open, prefill]);
  // 계좌가 없거나 고른 계좌가 사라지면 첫 계좌로
  useEffect(() => {
    if (v && !v.accounts.some((a) => a.id === form.account)) setForm((f) => ({ ...f, account: v.accounts[0]?.id ?? '' }));
  }, [v, form.account]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(id);
  }, [toast]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
      refreshAll();
      if (done) setToast(done);
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  const noAccount = !!v && v.accounts.length === 0;
  const shown: Tab = noAccount ? 'accounts' : tab;

  return (
    <aside className="drawer" role="dialog" aria-label="수기 자산 기록" tabIndex={-1} ref={panel}>
      <div className="dr-head">
        <h2>수기 자산 기록</h2>
        <button type="button" className="btn sm" onClick={onClose} aria-label="닫기">
          닫기
        </button>
      </div>
      <div className="seg dr-tabs" role="tablist" aria-label="기록 서랍">
        {(
          [
            ['new', editing ? '기록 고치기' : '새 기록'],
            ['list', `기록 목록${v ? ` ${v.records.length}` : ''}`],
            ['accounts', '계좌'],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={shown === k} aria-pressed={shown === k} disabled={noAccount && k !== 'accounts'} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {toast && (
        <p className="dr-toast" role="status">
          {toast}
        </p>
      )}
      <div className="dr-body">
        {!v ? (
          <p className="sub">{srv.error ? `불러오지 못했습니다: ${srv.error}` : '불러오는 중…'}</p>
        ) : shown === 'accounts' ? (
          <Accounts v={v} run={run} busy={busy} first={noAccount} onMade={() => setTab('new')} />
        ) : shown === 'list' ? (
          <RecordList
            v={v}
            busy={busy}
            run={run}
            onEdit={(r) => {
              setEditing(r.id);
              setErr('');
              setForm({ kind: r.kind, date: r.date, account: r.account, asset: r.asset || 'kr', symbol: r.symbol, name: r.name, qty: r.qty ? String(r.qty) : '', price: r.price ? String(r.price) : '', fee: r.fee ? String(r.fee) : '', amount: r.amount ? String(r.amount) : '', currency: r.currency });
              setTab('new');
            }}
          />
        ) : (
          <RecordForm
            v={v}
            form={form}
            setForm={setForm}
            editing={editing}
            busy={busy}
            err={err}
            candidates={candidates}
            onCancel={() => {
              setEditing(null);
              setForm(blank(form.account));
              setErr('');
            }}
            onSubmit={async (body) => {
              const ok = await run(() => (editing ? put(`/api/ledger/records/${editing}`, body) : post('/api/ledger/records', body)), editing ? '고쳤습니다' : `${kindLabel(form.kind)} 기록을 추가했습니다`);
              if (ok) {
                // 같은 계좌·종류로 다음 기록을 바로 넣을 수 있게 숫자만 비운다
                setForm((f) => ({ ...f, qty: '', price: '', fee: '', amount: '', ...(editing ? { symbol: '', name: '' } : {}) }));
                if (editing) {
                  setEditing(null);
                  setTab('list');
                }
              }
            }}
          />
        )}
        {err && shown !== 'new' && (
          <p className="o-warn" role="alert">
            {err}
          </p>
        )}
      </div>
    </aside>
  );
}

type Run = (fn: () => Promise<unknown>, done?: string) => Promise<boolean>;

function Seg<T extends string>({ label, list, cur, onPick }: { label: string; list: [T, string][]; cur: T; onPick: (v: T) => void }) {
  return (
    <div className="seg dr-seg" role="group" aria-label={label}>
      {list.map(([k, l]) => (
        <button key={k} type="button" aria-pressed={cur === k} onClick={() => onPick(k)}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`dr-field${wide ? ' wide' : ''}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function RecordForm({
  v,
  form,
  setForm,
  editing,
  busy,
  err,
  candidates,
  onCancel,
  onSubmit,
}: {
  v: View;
  form: Form;
  setForm: (f: (x: Form) => Form) => void;
  editing: string | null;
  busy: boolean;
  err: string;
  candidates: Candidate[];
  onCancel: () => void;
  onSubmit: (body: object) => void;
}) {
  const set = (k: keyof Form, val: string) =>
    setForm((f) => {
      const n = { ...f, [k]: val };
      if (k === 'kind') {
        if (val === 'value') n.asset = 'cash';
        else if (val !== 'div' && !TRADE.some(([a]) => a === f.asset)) n.asset = 'kr';
      }
      if (k === 'asset') {
        n.currency = val === 'us' ? 'USD' : 'KRW';
        n.symbol = '';
        n.name = '';
      }
      return n;
    });
  const trade = form.kind === 'buy' || form.kind === 'sell';
  const total = (Number(form.qty) || 0) * (Number(form.price) || 0) + (form.kind === 'buy' ? Number(form.fee) || 0 : -(Number(form.fee) || 0));
  return (
    <form
      className="dr-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
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
        });
      }}
    >
      <Seg label="기록 종류" list={KINDS} cur={form.kind} onPick={(k) => set('kind', k)} />
      <div className="dr-chips" role="group" aria-label="계좌">
        {v.accounts.map((a) => (
          <button key={a.id} type="button" className="chip" aria-pressed={form.account === a.id} onClick={() => set('account', a.id)}>
            {a.name}
          </button>
        ))}
      </div>
      {form.kind !== 'div' && <Seg label="자산 종류" list={form.kind === 'value' ? VALUE : TRADE} cur={form.asset} onPick={(k) => set('asset', k)} />}

      {trade && form.asset === 'kr' ? (
        <StockSearch candidates={candidates} symbol={form.symbol} name={form.name} onPick={(c, n) => setForm((f) => ({ ...f, symbol: c, name: n }))} />
      ) : trade ? (
        <div className="dr-grid">
          <Field label="티커">
            <input className="in" value={form.symbol} onChange={(e) => set('symbol', e.target.value.toUpperCase())} placeholder={form.asset === 'us' ? 'AAPL' : 'BTC'} />
          </Field>
          <Field label="이름 (비우면 티커)">
            <input className="in" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={form.asset === 'us' ? '애플' : '비트코인'} />
          </Field>
        </div>
      ) : (
        <Field label={form.kind === 'value' ? '이름' : '이름 (비우면 "배당·이자")'} wide>
          <input className="in" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={form.kind === 'value' ? (form.asset === 'cash' ? '예수금, 정기예금' : '전세보증금') : '삼성전자 배당'} />
        </Field>
      )}

      <div className="dr-grid">
        {trade ? (
          <>
            <Field label={form.asset === 'coin' ? '수량 (개)' : '수량 (주)'}>
              <input className="in big" inputMode="decimal" value={form.qty} onChange={(e) => set('qty', e.target.value)} />
            </Field>
            <Field label={`단가 (${form.currency === 'USD' ? '달러' : '원'})`}>
              <input className="in big" inputMode="decimal" value={form.price} onChange={(e) => set('price', e.target.value)} />
            </Field>
            <Field label="수수료·세금">
              <input className="in" inputMode="decimal" value={form.fee} onChange={(e) => set('fee', e.target.value)} placeholder="0" />
            </Field>
          </>
        ) : (
          <Field label={form.kind === 'value' ? `지금 금액 (${form.currency === 'USD' ? '달러' : '원'})` : `받은 금액 (${form.currency === 'USD' ? '달러' : '원'})`}>
            <input className="in big" inputMode="decimal" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
          </Field>
        )}
        <Field label="날짜">
          <input className="in" type="date" value={form.date} max={today()} onChange={(e) => set('date', e.target.value)} />
        </Field>
        {form.asset !== 'kr' && (
          <Field label="통화">
            <select className="in" value={form.currency} onChange={(e) => set('currency', e.target.value)}>
              <option value="KRW">원</option>
              <option value="USD">달러</option>
            </select>
          </Field>
        )}
      </div>

      {trade && total > 0 && (
        <p className="dr-total">
          {kindLabel(form.kind)} 합계 <b>{money(total, form.currency)}</b>
        </p>
      )}
      {err && (
        <p className="o-warn" role="alert">
          {err}
        </p>
      )}
      <div className="dr-actions">
        <button type="submit" className="btn pri" disabled={busy}>
          {editing ? '고친 것 저장' : `${kindLabel(form.kind)} 기록`}
        </button>
        {editing && (
          <button type="button" className="btn" onClick={onCancel}>
            취소
          </button>
        )}
      </div>
      {!editing && <p className="sub">저장해도 서랍은 열려 있어 다음 기록을 바로 넣을 수 있습니다. 이미 가진 자산은 산 날짜로 매수 한 줄을 넣으면 됩니다.</p>}
    </form>
  );
}

/** 국내 종목: 이름이나 코드로 찾기. 목록에 없으면 6자리 코드를 그대로 쓴다 */
function StockSearch({ candidates, symbol, name, onPick }: { candidates: Candidate[]; symbol: string; name: string; onPick: (code: string, name: string) => void }) {
  const [q, setQ] = useState(symbol ? `${name || symbol}` : '');
  const [openList, setOpenList] = useState(false);
  useEffect(() => setQ(symbol ? name || symbol : ''), [symbol, name]);
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return candidates.filter((c) => c.name.toLowerCase().includes(t) || c.code.startsWith(t)).slice(0, 8);
  }, [q, candidates]);
  const code6 = /^\d{6}$/.test(q.trim()) ? q.trim() : '';
  return (
    <div className="dr-search">
      <Field label="종목 (이름 또는 6자리 코드)" wide>
        <input
          className="in big"
          value={q}
          role="combobox"
          aria-expanded={openList && hits.length > 0}
          aria-autocomplete="list"
          onChange={(e) => {
            setQ(e.target.value);
            setOpenList(true);
            const t = e.target.value.trim();
            onPick(/^\d{6}$/.test(t) ? t : '', '');
          }}
          onFocus={() => setOpenList(true)}
          onBlur={() => setTimeout(() => setOpenList(false), 150)}
          placeholder="삼성전자 또는 005930"
        />
      </Field>
      {openList && hits.length > 0 && (
        <ul className="dr-hits" role="listbox">
          {hits.map((c) => (
            <li key={c.code} role="option" aria-selected={c.code === symbol}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(c.code, c.name);
                  setOpenList(false);
                }}
              >
                {c.name} <small>{c.code}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {symbol ? <p className="sub">고른 종목: {name || '이름은 저장할 때 자동'} ({symbol})</p> : code6 ? null : q && <p className="sub">목록에 없으면 6자리 종목코드를 넣어 주세요.</p>}
    </div>
  );
}

function RecordList({ v, busy, run, onEdit }: { v: View; busy: boolean; run: Run; onEdit: (r: Rec) => void }) {
  const [filter, setFilter] = useState('all');
  const acctName = (id: string) => v.accounts.find((a) => a.id === id)?.name ?? id;
  const recs = v.records.filter((r) => filter === 'all' || r.account === filter);
  return (
    <div className="dr-list">
      <div className="dr-chips" role="group" aria-label="계좌로 거르기">
        {[{ id: 'all', name: '전체' }, ...v.accounts].map((a) => (
          <button key={a.id} type="button" className="chip" aria-pressed={filter === a.id} onClick={() => setFilter(a.id)}>
            {a.name}
          </button>
        ))}
      </div>
      {recs.length === 0 ? (
        <p className="sub">기록이 없습니다.</p>
      ) : (
        <ul className="dr-recs">
          {recs.map((r) => (
            <li key={r.id}>
              <div className="dr-rec-main">
                <span className={`dr-kind k-${r.kind}`}>{kindLabel(r.kind)}</span>
                <b>{r.name}</b>
                <span className="sub">
                  {r.date} · {acctName(r.account)}
                </span>
              </div>
              <div className="dr-rec-num">
                {r.kind === 'buy' || r.kind === 'sell' ? (
                  <>
                    {num(r.qty)} × {money(r.price, r.currency)}
                    {r.fee ? <small className="sub"> 수수료 {money(r.fee, r.currency)}</small> : null}
                  </>
                ) : (
                  money(r.amount, r.currency)
                )}
              </div>
              <div className="dr-rec-btns">
                <button type="button" className="btn sm" onClick={() => onEdit(r)}>
                  고치기
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`${r.date} ${kindLabel(r.kind)} ${r.name} 기록을 지울까요?`)) run(() => del(`/api/ledger/records/${r.id}`), '지웠습니다');
                  }}
                >
                  지우기
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Accounts({ v, run, busy, first, onMade }: { v: View; run: Run; busy: boolean; first: boolean; onMade: () => void }) {
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="dr-accts">
      {first && <p>한투와 연동되지 않는 증권사, 코인 거래소, 은행을 계좌로 하나씩 만드세요. 넣은 기록은 내 자산 합계에 같이 들어갑니다.</p>}
      <form
        className="dr-inline"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => post('/api/ledger/accounts', { name }), `계좌 "${name.trim()}"을 만들었습니다`)) {
            setName('');
            onMade();
          }
        }}
      >
        <input className="in" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 키움, 업비트, 국민은행" aria-label="새 계좌 이름" autoFocus={first} />
        <button type="submit" className="btn pri" disabled={busy || !name.trim()}>
          계좌 만들기
        </button>
      </form>
      <ul className="dr-recs">
        {v.accounts.map((a) => (
          <li key={a.id}>
            {renaming?.id === a.id ? (
              <form
                className="dr-inline"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await run(() => put(`/api/ledger/accounts/${a.id}`, { name: renaming.name }), '이름을 바꿨습니다')) setRenaming(null);
                }}
              >
                <input className="in" value={renaming.name} onChange={(e) => setRenaming({ id: a.id, name: e.target.value })} aria-label="새 계좌 이름" autoFocus />
                <button type="submit" className="btn sm" disabled={busy}>
                  저장
                </button>
                <button type="button" className="btn sm" onClick={() => setRenaming(null)}>
                  취소
                </button>
              </form>
            ) : (
              <>
                <b className="dr-rec-main">{a.name}</b>
                <span className="sub">기록 {v.records.filter((r) => r.account === a.id).length}개</span>
                <div className="dr-rec-btns">
                  <button type="button" className="btn sm" onClick={() => setRenaming({ id: a.id, name: a.name })}>
                    이름 바꾸기
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`계좌 "${a.name}"을 지울까요? (기록이 있으면 지워지지 않습니다)`)) run(() => del(`/api/ledger/accounts/${a.id}`), '계좌를 지웠습니다');
                    }}
                  >
                    지우기
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
