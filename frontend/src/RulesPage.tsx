import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { del, post, put, refreshAll, usePoll, useServer } from './api';
import { fmt } from './lib';
import { useMarket, useHoldings } from './hooks';

// 규칙: 걸어 두면 서버가 실시간 시세로 지켜보다가 실행한다. 정의서 docs/pages/rules.md
// 실행 방식 (2026-11-23 사용자: 추천안): 매도 규칙은 알림만/확인 후 주문/자동 주문, 매수는 항상 확인, 알림은 알림만
type Kind = 'stop' | 'take' | 'trail' | 'buy' | 'alert';
type Mode = 'notify' | 'confirm' | 'auto';
type Rule = {
  id: string;
  code: string;
  name: string;
  kind: Kind;
  kindName: string;
  mode: Mode;
  modeName: string;
  text: string;
  state: 'watching' | 'paused' | 'fired' | 'expired' | 'failed';
  result?: string;
  now: number | null;
  trigger: number | null;
  dist: number | null;
  live: boolean;
  expires: number;
};
type Pending = { id: string; rule: string; name: string; code: string; text: string; price: number; until: number; kind: Kind };
type View = { rules: Rule[]; pending: Pending[]; halted: boolean; firedToday: number; marketOpen: boolean };

const KINDS: [Kind, string, string][] = [
  ['stop', '손절', '평균단가보다 내려가면 판다'],
  ['take', '익절', '평균단가보다 올라가면 판다'],
  ['trail', '추적 손절', '건 뒤 가장 높았던 가격에서 내려오면 판다'],
  ['buy', '조건부 매수', '정한 가격 이하로 오면 산다'],
  ['alert', '가격 알림', '주문 없이 알려만 준다'],
];
const STATE: Record<Rule['state'], string> = { watching: '감시 중', paused: '멈춤', fired: '발동함', expired: '만료', failed: '실패' };

export default function RulesPage() {
  const { live } = useServer();
  const srv = usePoll<View>(live ? '/api/rules' : null, 5000, true);
  const [sp, setSp] = useSearchParams();
  const [drawer, setDrawer] = useState<string | null>(sp.get('new'));
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const close = useCallback(() => {
    setDrawer(null);
    if (sp.get('new')) {
      const n = new URLSearchParams(sp);
      n.delete('new');
      setSp(n, { replace: true });
    }
  }, [sp, setSp]);

  if (!live)
    return (
      <div className="soon">
        <h1>규칙</h1>
        <p>규칙은 한투 모의계좌에 연결된 서버에서만 걸 수 있습니다. 지금은 예시 화면입니다.</p>
      </div>
    );
  const v = srv.data;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      setMsg(ok);
      refreshAll();
    } catch (e) {
      setMsg(`안 됨: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const watching = v?.rules.filter((r) => r.state === 'watching').length ?? 0;

  return (
    <div className="orders rules">
      <section className="summary" aria-label="규칙 요약">
        <div className="sum-item">
          <span className="sum-k">감시 중</span>
          <b className="sum-v">{v ? `${watching}개` : '-'}</b>
          <span className="sum-s">{v ? (v.halted ? '모두 정지 중' : v.marketOpen ? '장중 · 실시간으로 지켜보는 중' : '장 마감 · 장중에만 발동') : '불러오는 중'}</span>
        </div>
        <div className="sum-item">
          <span className="sum-k">확인 대기</span>
          <b className={`sum-v${v?.pending.length ? ' warn-text' : ''}`}>{v ? `${v.pending.length}건` : '-'}</b>
        </div>
        <div className="sum-item">
          <span className="sum-k">오늘 발동</span>
          <b className="sum-v">{v ? `${v.firedToday}번` : '-'}</b>
        </div>
        <span className="grow" />
        {v && (
          <button
            type="button"
            className={`btn ${v.halted ? 'pri' : 'danger'}`}
            disabled={busy}
            onClick={() => {
              if (v.halted || window.confirm('모든 규칙을 멈출까요? 다시 시작하기 전까지 아무 규칙도 발동하지 않고, 확인 대기도 지워집니다.'))
                run(() => post('/api/rules/halt', { on: !v.halted }), v.halted ? '규칙을 다시 시작했습니다' : '모든 규칙을 멈췄습니다');
            }}
          >
            {v.halted ? '다시 시작' : '모두 정지'}
          </button>
        )}
        <button type="button" className="btn pri" onClick={() => setDrawer('')} aria-haspopup="dialog">
          ＋ 규칙
        </button>
      </section>

      {v?.halted && <p className="o-warn">모두 정지 중입니다. 어떤 규칙도 발동하지 않습니다.</p>}
      {msg && (
        <p className={msg.startsWith('안 됨') ? 'o-warn' : 'o-ok'} role="status">
          {msg}
        </p>
      )}

      {v && v.pending.length > 0 && (
        <section className="card pending-card" aria-labelledby="h-pend">
          <div className="card-head">
            <h2 id="h-pend">확인 대기</h2>
            <span className="sub">5분 안에 [주문]을 눌러야 나갑니다. 지나면 취소</span>
          </div>
          <ul className="pend-list">
            {v.pending.map((p) => (
              <PendingRow key={p.id} p={p} busy={busy} run={run} />
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>규칙</h2>
          <span className="sub">서버가 지켜봅니다. 화면을 닫아도 동작합니다 (서버가 켜져 있는 동안)</span>
        </div>
        {!v ? (
          <p className="sub">{srv.error ? `불러오지 못했습니다: ${srv.error}` : '불러오는 중…'}</p>
        ) : v.rules.length === 0 ? (
          <div className="empty">
            <p>아직 규칙이 없습니다.</p>
            <p className="sub">예: "삼성전자가 평균단가보다 5% 내려가면 전부 판다"</p>
            <button type="button" className="btn pri" onClick={() => setDrawer('')}>
              첫 규칙 만들기
            </button>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl od-tbl">
              <thead>
                <tr>
                  <th scope="col">종목</th>
                  <th scope="col">규칙</th>
                  <th scope="col" className="num">
                    지금
                  </th>
                  <th scope="col" className="num">
                    발동 가격
                  </th>
                  <th scope="col">발동까지</th>
                  <th scope="col">실행</th>
                  <th scope="col">상태</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {v.rules.map((r) => (
                  <tr key={r.id} className={r.state === 'watching' ? undefined : 'dim'}>
                    <td className="od-name">
                      <Link to={`/stock/${r.code}`} className="tname">
                        {r.name} <small>{r.code}</small>
                      </Link>
                    </td>
                    <td data-l="규칙">
                      <b>{r.kindName}</b> <span className="sub">{r.text.split(': ')[1]}</span>
                    </td>
                    <td className="num" data-l="지금">
                      {r.now ? fmt(r.now) : '-'}
                      {!r.live && r.state === 'watching' && <small className="sub" title="실시간 자리가 없거나 아직 안 받음"> 조회</small>}
                    </td>
                    <td className="num" data-l="발동 가격">
                      {r.trigger ? fmt(r.trigger) : '-'}
                    </td>
                    <td data-l="발동까지">{r.state === 'watching' && r.dist !== null ? <Dist d={r.dist} /> : '-'}</td>
                    <td data-l="실행">{r.modeName}</td>
                    <td data-l="상태">
                      <span className={`st rs-${r.state}`}>{STATE[r.state]}</span>
                      {r.result && <small className="sub"> {r.result}</small>}
                    </td>
                    <td className="num od-btns">
                      {r.state === 'watching' ? (
                        <button type="button" className="btn sm" disabled={busy} onClick={() => run(() => put(`/api/rules/${r.id}`, { state: 'paused' }), '멈췄습니다')}>
                          멈춤
                        </button>
                      ) : (
                        <button type="button" className="btn sm" disabled={busy} onClick={() => run(() => put(`/api/rules/${r.id}`, { state: 'watching' }), '다시 켰습니다')}>
                          {r.state === 'paused' ? '켜기' : '다시 켜기'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy}
                        onClick={() => window.confirm(`"${r.text}" 규칙을 지울까요?`) && run(() => del(`/api/rules/${r.id}`), '지웠습니다')}
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
        <p className="sub">모의투자. 주문은 장중에만 나가고, 서버가 장 시간·1회 한도·하루 횟수·매도 가능 수량·매수 가능 금액을 다시 검사합니다.</p>
      </section>

      {drawer !== null && <RuleDrawer code={drawer} onClose={close} onDone={(m) => setMsg(m)} />}
    </div>
  );
}

/** 발동까지 남은 거리: 0%에 가까울수록 막대가 찬다 */
function Dist({ d }: { d: number }) {
  const near = Math.max(0, 1 - Math.min(Math.abs(d), 10) / 10);
  return (
    <span className="dist" title="지금 가격에서 발동 가격까지">
      <span className="dist-bar" aria-hidden="true">
        <i style={{ width: `${near * 100}%` }} className={near > 0.7 ? 'near' : undefined} />
      </span>
      <span className="num">
        {d > 0 ? '+' : ''}
        {d.toFixed(1)}%
      </span>
    </span>
  );
}

function PendingRow({ p, busy, run }: { p: Pending; busy: boolean; run: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const left = Math.max(0, Math.round(p.until - Date.now() / 1000));
  return (
    <li>
      <div>
        <b>{p.name}</b> <span className="sub">{p.text.split(': ')[1]}</span>
        <div className="sub">
          발동 가격 {fmt(p.price)}원 · 남은 시간 {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
        </div>
      </div>
      <div className="od-btns">
        <button type="button" className={`o-go ${p.kind === 'buy' ? 'buy' : 'sell'}`} disabled={busy || left === 0} onClick={() => run(() => post(`/api/rules/pending/${p.id}/go`, {}), `${p.name} 주문 접수됐습니다`)}>
          주문
        </button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => run(() => post(`/api/rules/pending/${p.id}/dismiss`, {}), '무시했습니다')}>
          무시
        </button>
      </div>
    </li>
  );
}

/* ---------- 규칙 만들기 서랍 ---------- */
function RuleDrawer({ code: initCode, onClose, onDone }: { code: string; onClose: () => void; onDone: (m: string) => void }) {
  const { stocks } = useMarket();
  const { holdings } = useHoldings('kis');
  const [kind, setKindRaw] = useState<Kind>('stop');
  const [touched, setTouched] = useState(false);
  const setKind = (k: Kind) => {
    setTouched(true);
    setKindRaw(k);
  };
  const [code, setCode] = useState(initCode);
  const [by, setBy] = useState<'pct' | 'price'>('pct');
  const [pct, setPct] = useState('5');
  const [price, setPrice] = useState('');
  const [dir, setDir] = useState<'below' | 'above' | 'day'>('below');
  const [all, setAll] = useState(true);
  const [qty, setQty] = useState('');
  const [mode, setMode] = useState<Mode>('confirm');
  const [days, setDays] = useState('30');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 보유 정보가 온 뒤에 기본 종류를 정한다: 가진 종목이면 손절, 아니면 조건부 매수
  const holdingsReady = holdings.length > 0;
  useEffect(() => {
    if (!touched && initCode && holdingsReady) setKindRaw(holdings.some((h) => h.code === initCode) ? 'stop' : 'buy');
  }, [touched, initCode, holdingsReady, holdings]);
  const sell = kind === 'stop' || kind === 'take' || kind === 'trail';
  const held = holdings.find((h) => h.code === code);
  const choices = useMemo(() => {
    if (sell) return holdings.map((h) => ({ code: h.code, name: h.name ?? h.code }));
    const m = new Map<string, string>();
    holdings.forEach((h) => m.set(h.code, h.name ?? h.code));
    stocks.forEach((s) => m.set(s.code, s.name));
    return [...m].map(([c, n]) => ({ code: c, name: n }));
  }, [sell, holdings, stocks]);
  const now = stocks.find((s) => s.code === code)?.price ?? held?.price;
  const name = choices.find((c) => c.code === code)?.name ?? code;
  const nPct = Number(pct) || 0;
  const nPrice = Number(price) || 0;
  const qtyText = sell ? (all ? `전부(${fmt(held?.qty ?? 0)}주)` : `${fmt(Number(qty) || 0)}주`) : `${fmt(Number(qty) || 0)}주`;
  const modeName = kind === 'buy' ? '확인 후 주문' : kind === 'alert' ? '알림만' : { notify: '알림만', confirm: '확인 후 주문', auto: '자동 주문' }[mode];
  // 만들기 전에 문장으로 보여 준다
  const preview = (() => {
    if (!code) return '종목을 고르세요';
    if ((kind === 'stop' || kind === 'take') && by === 'price' && !nPrice) return '가격을 넣으세요';
    if (kind === 'stop' || kind === 'take') {
      const t = by === 'price' ? nPrice : held ? Math.round(held.avg * (1 + ((kind === 'stop' ? -1 : 1) * nPct) / 100)) : 0;
      const cond = by === 'price' ? `${fmt(nPrice)}원 ${kind === 'stop' ? '이하' : '이상'}` : `평균단가 ${fmt(held?.avg ?? 0)}원보다 ${nPct}% ${kind === 'stop' ? '내려' : '올라'} ${fmt(t)}원 ${kind === 'stop' ? '이하' : '이상'}`;
      return `${name}이(가) ${cond}${kind === 'stop' ? '가' : '이'} 되면 ${qtyText}를 시장가로 팝니다 (${modeName}).`;
    }
    if (kind === 'trail') return `${name}이(가) 지금부터 가장 높았던 가격에서 ${nPct}% 내려오면 ${qtyText}를 시장가로 팝니다 (${modeName}). 지금 ${fmt(now ?? 0)}원 기준 발동 가격 ${fmt(Math.round((now ?? 0) * (1 - nPct / 100)))}원부터 시작합니다.`;
    if (kind === 'buy' && !(nPrice && Number(qty))) return '매수 가격과 수량을 넣으세요';
    if (kind === 'alert' && dir !== 'day' && !nPrice) return '알림 가격을 넣으세요';
    if (kind === 'buy') return `${name}이(가) ${fmt(nPrice)}원 이하가 되면 ${qtyText}를 ${fmt(nPrice)}원 지정가로 삽니다 (약 ${fmt(nPrice * (Number(qty) || 0))}원, 확인 후 주문).`;
    if (dir === 'day') return `${name}이(가) 오늘 ${nPct > 0 ? '+' : ''}${nPct}% ${nPct < 0 ? '이하' : '이상'}이 되면 알려 줍니다.`;
    return `${name}이(가) ${fmt(nPrice)}원 ${dir === 'above' ? '이상' : '이하'}이 되면 알려 줍니다.`;
  })();

  const submit = async () => {
    setBusy(true);
    setErr('');
    const body: Record<string, unknown> = { code, kind, days: Number(days) || 30 };
    if (sell) {
      Object.assign(body, { mode, qty: all ? null : Number(qty) || 0 });
      if (kind === 'trail' || by === 'pct') body.pct = nPct;
      else body.price = nPrice;
    } else if (kind === 'buy') Object.assign(body, { price: nPrice, qty: Number(qty) || 0 });
    else Object.assign(body, dir === 'day' ? { dir, pct: nPct } : { dir, price: nPrice });
    try {
      await post('/api/rules', body);
      refreshAll();
      onDone(`규칙을 걸었습니다: ${preview}`);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="drawer" role="dialog" aria-label="규칙 만들기">
      <div className="dr-head">
        <h2>규칙 만들기</h2>
        <button type="button" className="btn sm" onClick={onClose}>
          닫기
        </button>
      </div>
      <form
        className="dr-body dr-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="kind-grid" role="group" aria-label="규칙 종류">
          {KINDS.map(([k, l, d]) => (
            <button
              key={k}
              type="button"
              className="kind-card"
              aria-pressed={kind === k}
              onClick={() => {
                setKind(k);
                if (k === 'alert') setDir('below');
              }}
            >
              <b>{l}</b>
              <span>{d}</span>
            </button>
          ))}
        </div>

        <label className="dr-field">
          <span>{sell ? '종목 (한투 계좌에 가진 것)' : '종목'}</span>
          <select className="in big" value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">고르세요</option>
            {choices.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.code})
              </option>
            ))}
          </select>
        </label>
        {sell && holdings.length === 0 && <p className="o-warn">한투 계좌에 가진 종목이 없어 매도 규칙을 걸 수 없습니다. 조건부 매수나 가격 알림은 됩니다.</p>}
        {code && (
          <p className="sub">
            지금 {now ? `${fmt(now)}원` : '-'}
            {held && ` · 평균단가 ${fmt(held.avg)}원 · ${fmt(held.qty)}주 보유`}
          </p>
        )}

        {(kind === 'stop' || kind === 'take') && (
          <div className="seg dr-seg" role="group" aria-label="조건 기준">
            <button type="button" aria-pressed={by === 'pct'} onClick={() => setBy('pct')}>
              평균단가 대비 %
            </button>
            <button type="button" aria-pressed={by === 'price'} onClick={() => setBy('price')}>
              가격
            </button>
          </div>
        )}
        {kind === 'alert' && (
          <div className="seg dr-seg" role="group" aria-label="알림 조건">
            {(
              [
                ['below', '가격 이하'],
                ['above', '가격 이상'],
                ['day', '오늘 등락 %'],
              ] as const
            ).map(([k, l]) => (
              <button key={k} type="button" aria-pressed={dir === k} onClick={() => setDir(k)}>
                {l}
              </button>
            ))}
          </div>
        )}
        <div className="dr-grid">
          {((sell && (kind === 'trail' || by === 'pct')) || (kind === 'alert' && dir === 'day')) && (
            <label className="dr-field">
              <span>{kind === 'alert' ? '오늘 등락 % (내려가면 −)' : kind === 'trail' ? '최고가에서 내려오는 %' : '%'}</span>
              <input className="in big" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} />
            </label>
          )}
          {((sell && kind !== 'trail' && by === 'price') || kind === 'buy' || (kind === 'alert' && dir !== 'day')) && (
            <label className="dr-field">
              <span>가격 (원)</span>
              <input className="in big" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))} placeholder={now ? String(now) : ''} />
            </label>
          )}
          {(sell || kind === 'buy') && (
            <label className="dr-field">
              <span>수량</span>
              {sell ? (
                <span className="qty-row">
                  <button type="button" className="chip" aria-pressed={all} onClick={() => setAll(true)}>
                    전부
                  </button>
                  <input className="in" inputMode="numeric" value={all ? '' : qty} placeholder="n주" onFocus={() => setAll(false)} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} aria-label="매도 수량" />
                </span>
              ) : (
                <input className="in big" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
              )}
            </label>
          )}
          <label className="dr-field">
            <span>기한 (일)</span>
            <input className="in" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />
          </label>
        </div>

        <div className="dr-field">
          <span>발동하면</span>
          {sell ? (
            <div className="seg dr-seg" role="group" aria-label="실행 방식">
              {(
                [
                  ['confirm', '확인 후 주문'],
                  ['auto', '자동 주문'],
                  ['notify', '알림만'],
                ] as const
              ).map(([k, l]) => (
                <button key={k} type="button" aria-pressed={mode === k} onClick={() => setMode(k)}>
                  {l}
                </button>
              ))}
            </div>
          ) : (
            <p className="sub">{kind === 'buy' ? '매수 규칙은 항상 확인 후 주문입니다 (5분 안에 [주문]을 눌러야 나감)' : '주문 없이 알림만'}</p>
          )}
          {sell && mode === 'auto' && <p className="o-warn">조건이 맞으면 확인 없이 서버가 바로 시장가로 팝니다 (모의투자).</p>}
        </div>

        <p className="dr-total">{preview}</p>
        {err && (
          <p className="o-warn" role="alert">
            {err}
          </p>
        )}
        <div className="dr-actions">
          <button type="submit" className="btn pri" disabled={busy || !code}>
            규칙 걸기
          </button>
        </div>
      </form>
    </aside>
  );
}
