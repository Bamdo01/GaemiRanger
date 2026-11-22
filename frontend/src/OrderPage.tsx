import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { post, refreshAll, useMode, usePoll, useServer } from './api';
import { tickOf } from './data';
import { fmt } from './lib';
import { Seg, type Opt } from './Pickers';

// 주문: 낸 주문을 보고 고치는 곳 (새 주문은 종목 화면). 정의서 docs/pages/order.md
type Order = { no: string; date: string; time: string; code: string; name: string; side: 'buy' | 'sell'; kind: string; price: number; qty: number; filled: number; avg: number; left: number; status: string };
type Res = { orders: Order[]; summary: { open: number; filled: number; buyAmt: number; sellAmt: number }; marketOpen: boolean };

const TABS: Opt = [
  ['open', '미체결'],
  ['today', '오늘 전체'],
  ['past', '지난 주문'],
];
const DAYS: Opt = [
  ['7', '1주'],
  ['30', '1달'],
];
const sideName = (s: string) => (s === 'buy' ? '매수' : '매도');

type Pending = { title: string; lines: [string, string][]; note?: string; go: () => Promise<unknown>; label: string; side?: string };

export default function OrderPage() {
  const { live } = useServer();
  const mode = useMode();
  const [sp, setSp] = useSearchParams();
  const tab = TABS.some(([k]) => k === sp.get('tab')) ? sp.get('tab')! : 'open';
  const days = sp.get('days') === '7' ? '7' : '30';
  const set = (k: string, v: string, def: string) => {
    const n = new URLSearchParams(sp);
    if (v === def) n.delete(k);
    else n.set(k, v);
    setSp(n, { replace: true });
  };
  const srv = usePoll<Res>(live ? `/api/orders?scope=${tab}&days=${days}` : null, tab === 'past' ? 60_000 : 5_000);
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  if (!live)
    return (
      <div className="soon">
        <h1>주문</h1>
        <p>한투 계좌에 연결된 서버에서만 낸 주문을 볼 수 있습니다. 지금은 예시 화면이라 주문 내역이 없습니다.</p>
        <Link to="/stock" className="btn">
          종목 화면에서 주문하기
        </Link>
      </div>
    );

  const d = srv.data;
  const s = d?.summary;
  const openOrders = d?.orders.filter((o) => o.left > 0 && o.status !== '취소됨') ?? [];
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      setMsg(ok);
      setEditing(null);
      refreshAll();
    } catch (e) {
      setMsg(`안 됨: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  return (
    <div className="orders">
      <section className="summary" aria-label="오늘 주문 요약">
        <div className="sum-item">
          <span className="sum-k">미체결</span>
          <b className="sum-v">{s ? `${s.open}건` : '-'}</b>
          <span className="sum-s">{d ? (d.marketOpen ? '장중 · 5초마다 갱신' : '장 마감 · 정정·취소는 장중에만') : '불러오는 중'}</span>
        </div>
        <div className="sum-item">
          <span className="sum-k">오늘 체결</span>
          <b className="sum-v">{s ? `${s.filled}건` : '-'}</b>
        </div>
        <div className="sum-item">
          <span className="sum-k">오늘 매수 체결</span>
          <b className="sum-v">{s ? `${fmt(s.buyAmt)}원` : '-'}</b>
        </div>
        <div className="sum-item">
          <span className="sum-k">오늘 매도 체결</span>
          <b className="sum-v">{s ? `${fmt(s.sellAmt)}원` : '-'}</b>
        </div>
        <span className="grow" />
        {s && s.open > 0 && (
          <button
            type="button"
            className="btn"
            disabled={busy || !d?.marketOpen}
            title={d?.marketOpen ? undefined : '장중에만 취소할 수 있습니다'}
            onClick={() =>
              setPending({
                title: `미체결 ${s.open}건 모두 취소`,
                lines: openOrders.map((o): [string, string] => [o.name, `${sideName(o.side)} 남은 ${fmt(o.left)}주`]),
                go: () => post('/api/orders/cancel-all', {}),
                label: '모두 취소 확정',
              })
            }
          >
            모두 취소
          </button>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <Seg id="주문 보기" label="" list={TABS} cur={tab} onPick={(v) => set('tab', v, 'open')} />
          {tab === 'past' && <Seg id="기간" label="" list={DAYS} cur={days} onPick={(v) => set('days', v, '30')} />}
        </div>
        {msg && (
          <p className={msg.startsWith('안 됨') ? 'o-warn' : 'o-ok'} role="status">
            {msg}
          </p>
        )}
        {srv.error && <p className="o-warn">주문을 불러오지 못했습니다: {srv.error}</p>}
        {!d ? (
          <p className="sub">불러오는 중…</p>
        ) : d.orders.length === 0 ? (
          <div className="empty">
            <p>{tab === 'open' ? '미체결 주문이 없습니다.' : tab === 'today' ? '오늘 낸 주문이 없습니다.' : '이 기간에 낸 주문이 없습니다.'}</p>
            <Link to="/stock" className="btn">
              종목 화면에서 주문하기
            </Link>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl od-tbl">
              <thead>
                <tr>
                  <th scope="col">{tab === 'past' ? '날짜 · 시각' : '시각'}</th>
                  <th scope="col">종목</th>
                  <th scope="col">구분</th>
                  <th scope="col" className="num">
                    주문가
                  </th>
                  <th scope="col" className="num">
                    주문
                  </th>
                  <th scope="col" className="num">
                    체결
                  </th>
                  <th scope="col" className="num">
                    남음
                  </th>
                  <th scope="col">상태</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {d.orders.map((o) => {
                  const canEdit = o.left > 0 && o.status !== '취소됨';
                  return (
                    <OrderRow
                      key={o.no}
                      o={o}
                      past={tab === 'past'}
                      canEdit={canEdit}
                      marketOpen={d.marketOpen}
                      editing={editing === o.no}
                      busy={busy}
                      onEdit={() => setEditing(editing === o.no ? null : o.no)}
                      onCancel={() =>
                        setPending({
                          title: '주문 취소',
                          lines: [
                            ['종목', o.name],
                            ['주문', `${sideName(o.side)} ${fmt(o.qty)}주 · ${o.kind === 'market' ? '시장가' : `${fmt(o.price)}원`}`],
                            ['취소할 수량', `남은 ${fmt(o.left)}주 전부`],
                          ],
                          go: () => post(`/api/orders/${o.no}/cancel`, {}),
                          label: '취소 확정',
                        })
                      }
                      onModify={(price, qty) =>
                        setPending({
                          title: '주문 정정',
                          lines: [
                            ['종목', o.name],
                            ['지금', `${sideName(o.side)} 남은 ${fmt(o.left)}주 · ${fmt(o.price)}원`],
                            ['바꿀 것', `${fmt(qty)}주 · ${fmt(price)}원`],
                            ['금액', `약 ${fmt(price * qty)}원`],
                          ],
                          note: qty < o.left ? `남은 ${fmt(o.left - qty)}주는 그대로 원래 가격에 남습니다.` : undefined,
                          go: () => post(`/api/orders/${o.no}/modify`, { price, qty }),
                          label: '정정 확정',
                          side: o.side,
                        })
                      }
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="sub">새 주문은 종목 화면에서 냅니다. 정정·취소는 확인창을 거쳐야 나가고, 서버가 한 번 더 검사합니다 ({mode.name}).</p>
      </section>

      {pending && (
        <div className="modal-back" onClick={() => !busy && setPending(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="od-t" onClick={(e) => e.stopPropagation()}>
            <h2 id="od-t">{pending.title}</h2>
            <dl>
              {pending.lines.map(([k, v], i) => (
                <div key={i}>
                  <dt>{k}</dt>
                  <dd className="num">{v}</dd>
                </div>
              ))}
            </dl>
            {pending.note && <p className="sub">{pending.note}</p>}
            <p className={mode.real ? 'o-warn' : 'sub'}>{mode.real ? '한투 실전 계좌로 나갑니다. 실제 돈이 움직입니다.' : '한투 모의투자 계좌로 나갑니다 (실제 돈은 움직이지 않음)'}</p>
            <div className="row">
              <button type="button" className="btn" autoFocus onClick={() => setPending(null)} disabled={busy}>
                닫기
              </button>
              <button type="button" className={`o-go ${pending.side ?? 'sell'}`} disabled={busy} onClick={() => run(pending.go, `${pending.title} 접수됐습니다`)}>
                {busy ? '보내는 중…' : pending.label}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OrderRow({
  o,
  past,
  canEdit,
  marketOpen,
  editing,
  busy,
  onEdit,
  onCancel,
  onModify,
}: {
  o: Order;
  past: boolean;
  canEdit: boolean;
  marketOpen: boolean;
  editing: boolean;
  busy: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onModify: (price: number, qty: number) => void;
}) {
  const [price, setPrice] = useState(o.price);
  const [qty, setQty] = useState(o.left);
  const t = tickOf(price);
  const why = marketOpen ? undefined : '장중에만 할 수 있습니다';
  return (
    <>
      <tr className={editing ? 'editing' : undefined}>
        <td className="num" data-l="시각">{past ? `${o.date.slice(5)} ${o.time.slice(0, 5)}` : o.time}</td>
        <td className="od-name">
          <Link to={`/stock/${o.code}`} className="tname">
            {o.name} <small>{o.code}</small>
          </Link>
        </td>
        <td data-l="구분" className={o.side === 'buy' ? 'side-buy' : 'side-sell'}>{sideName(o.side)}</td>
        <td className="num" data-l="주문가">{o.kind === 'market' ? '시장가' : fmt(o.price)}</td>
        <td className="num" data-l="주문">{fmt(o.qty)}</td>
        <td className="num" data-l="체결">
          {fmt(o.filled)}
          {o.filled > 0 && o.avg > 0 && <small className="sub"> @{fmt(o.avg)}</small>}
        </td>
        <td className="num" data-l="남음">{fmt(o.left)}</td>
        <td data-l="상태">
          <span className={`st st-${o.status.replace(' ', '')}`}>{o.status}</span>
        </td>
        <td className="num od-btns">
          {canEdit && (
            <>
              <button type="button" className="btn sm" disabled={busy || !marketOpen || o.kind === 'market'} title={o.kind === 'market' ? '시장가 주문은 정정하지 않습니다' : why} onClick={onEdit} aria-expanded={editing}>
                정정
              </button>
              <button type="button" className="btn sm" disabled={busy || !marketOpen} title={why} onClick={onCancel}>
                취소
              </button>
            </>
          )}
        </td>
      </tr>
      {editing && (
        <tr className="editing">
          <td colSpan={9}>
            <form
              className="od-edit"
              onSubmit={(e) => {
                e.preventDefault();
                onModify(price, qty);
              }}
            >
              <span className="sub">새 가격</span>
              <button type="button" className="btn sm step" onClick={() => setPrice((p) => Math.max(t, p - tickOf(p - 1)))} aria-label="한 호가 내리기">
                −
              </button>
              <input className="in sm num" inputMode="numeric" value={price} onChange={(e) => setPrice(Number(e.target.value.replace(/\D/g, '')) || 0)} aria-label="새 가격" />
              <button type="button" className="btn sm step" onClick={() => setPrice((p) => p + tickOf(p))} aria-label="한 호가 올리기">
                +
              </button>
              <span className="sub">수량 (남은 {fmt(o.left)}주까지)</span>
              <input className="in sm num" inputMode="numeric" value={qty} onChange={(e) => setQty(Math.min(o.left, Number(e.target.value.replace(/\D/g, '')) || 0))} aria-label="정정 수량" />
              <button type="submit" className="btn pri sm" disabled={!price || !qty || price % tickOf(price) !== 0}>
                정정 주문
              </button>
              {price % tickOf(price) !== 0 && <span className="o-warn">호가 단위 {fmt(tickOf(price))}원에 맞춰 주세요</span>}
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
