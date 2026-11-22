import { useEffect, useRef, useState } from 'react';
import { postStream, useServer } from './api';
import { fmt, signPct } from './lib';
import { checksOf, type Facts, type Portfolio } from './portfolio';

// AI 리뷰와 AI에게 묻기. 서버에 AI 키가 있으면 Claude 가 실제 포트폴리오로 답한다 (/api/ai/chat, 글자가 오는 대로).
// 키가 없거나 서버가 없으면 예시 글. AI 에게 주문 도구는 없다 (읽기 전용 숫자만 보냄).

type Investor = 'buffett' | 'graham' | 'lynch' | 'bogle' | 'dalio';
const INVESTORS: [Investor, string, string][] = [
  ['buffett', '워런 버핏', '좋은 기업을 오래, 몰아서'],
  ['graham', '벤저민 그레이엄', '싸게 사기, 안전마진'],
  ['lynch', '피터 린치', '아는 기업, 적당한 가격의 성장'],
  ['bogle', '존 보글', '지수에 분산, 낮은 비용'],
  ['dalio', '레이 달리오', '자산 배분, 위험 균형'],
];
const IKEY = 'gaemiranger.investor';
const nameOf = (i: Investor) => INVESTORS.find(([x]) => x === i)![1];

/** 예시 리뷰 (세 줄). AI가 연결되면 서버가 만든 글로 바뀐다. */
function sampleReview(inv: Investor, f: Facts): string[] {
  const loser = f.losers[0] ? `${f.losers[0].s.name}(${signPct(f.losers[0].profit)})` : '손실 종목';
  switch (inv) {
    case 'buffett':
      return [
        `${f.topSector} ${f.sectorPct.toFixed(0)}% 집중은 그 기업들을 10년 볼 확신이 있다면 문제 아님.`,
        `${loser}은 처음 산 이유가 아직 맞는지 다시 적어 보기.`,
        `새로 살 때는 한 문장으로 설명되는 기업만.`,
      ];
    case 'graham':
      return [
        `${f.n}종목은 그레이엄이 권한 10~30종목보다 적음. ${f.top.s.name} 한 종목이 ${f.topPct.toFixed(0)}%.`,
        `PER·PBR이 연결되면 가격이 가치보다 싼지 종목마다 확인.`,
        `"얼마면 싸다"를 먼저 정하고 그 아래에서만 사기 (조건부 매수 규칙).`,
      ];
    case 'lynch':
      return [
        `보유 ${f.n}종목을 저성장·우량·고성장·경기순환·회생·자산주로 나눠 보기.`,
        `${loser}을 왜 갖고 있는지 2분 안에 설명되는지 확인.`,
        `잘 아는 회사 중 이익은 느는데 주가가 덜 오른 곳 찾기.`,
      ];
    case 'bogle':
      return [
        `오늘 코스피 대비 ${f.vs >= 0 ? '+' : ''}${f.vs.toFixed(2)}%p. 1년 이상 지수와 비교해야 의미 있음.`,
        `핵심은 지수 ETF, 고르고 싶은 종목은 작은 비중으로.`,
        `매매를 줄여 수수료와 세금 아끼기.`,
      ];
    case 'dalio':
      return [
        `주식 ${(100 - f.cashPct).toFixed(0)}%, 현금 ${f.cashPct.toFixed(0)}%, 채권·금 없음. 경기 좋을 때만 잘 되는 구성.`,
        `${f.topSector}처럼 같이 움직이는 종목이 많으면 분산 효과가 작음.`,
        `서로 다르게 움직이는 자산을 섞어 위험 균형 맞추기.`,
      ];
  }
}

/** 보유 구성만 보고 고른 닮은 투자자 (매매 습관은 체결 내역 연결 후) */
function similar(f: Facts): Investor {
  if (f.n <= 8 && f.topPct >= 20) return 'buffett';
  if (f.n >= 20) return 'bogle';
  return 'lynch';
}

type Msg = { who: 'me' | 'ai'; text: string };

export default function AiReview({ port, kospiPct }: { port: Portfolio; kospiPct: number }) {
  const [inv, setInv] = useState<Investor>(() => {
    try {
      const v = localStorage.getItem(IKEY) as Investor | null;
      if (v && INVESTORS.some(([x]) => x === v)) return v;
    } catch {
      /* 무시 */
    }
    return 'buffett';
  });
  useEffect(() => {
    try {
      localStorage.setItem(IKEY, inv);
    } catch {
      /* 무시 */
    }
  }, [inv]);

  const f = checksOf(port, kospiPct).facts;
  const sim = similar(f);
  const { live, status } = useServer();
  const real = live && !!status.kis?.ai; // 진짜 AI
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ inv: Investor; text: string; at: number } | null>(null);
  const [err, setErr] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [msgs]);

  const ask = async (q: string) => {
    const t = q.trim();
    if (!t || busy) return;
    setText('');
    setErr('');
    if (!real) {
      setMsgs((m) => [...m, { who: 'me', text: t }, { who: 'ai', text: `(예시 답변) AI가 연결되면 지금 포트폴리오(총자산 ${fmt(port.total)}원, ${f.n}종목)를 바탕으로 ${nameOf(inv)} 관점에서 답합니다.` }]);
      return;
    }
    const history = [...msgs, { who: 'me' as const, text: t }];
    setMsgs([...history, { who: 'ai', text: '' }]);
    setBusy(true);
    try {
      await postStream(
        '/api/ai/chat',
        { investor: inv, messages: history.map((m) => ({ role: m.who === 'me' ? 'user' : 'assistant', content: m.text })) },
        (all) => setMsgs([...history, { who: 'ai', text: all }]),
      );
    } catch (e) {
      setMsgs(history);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const getReview = async () => {
    setBusy(true);
    setErr('');
    setReview({ inv, text: '', at: Date.now() });
    try {
      await postStream('/api/ai/chat', { investor: inv, review: true }, (all) => setReview({ inv, text: all, at: Date.now() }));
    } catch (e) {
      setReview(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const lines = review && review.inv === inv ? review.text.split('\n').map((l) => l.replace(/^[-•]\s*/, '').trim()).filter(Boolean) : null;
  const suggest = [`${f.topSector} 비중을 줄여야 할까?`, '현금은 얼마나 두는 게 좋을까?'];

  return (
    <section className="card ai" aria-labelledby="h-ai">
      <div className="card-head">
        <h2 id="h-ai">AI 리뷰</h2>
        <span className="sub">{real ? 'Claude · 참고용 (주문은 하지 않음)' : live ? '예시 · AI 키 없음 (backend/.env 의 ANTHROPIC_API_KEY)' : '예시 · AI 연결 전'}</span>
      </div>

      <div className="ai-pick">
        <label htmlFor="ai-inv">관점</label>
        <select id="ai-inv" className="dd" value={inv} onChange={(e) => setInv(e.target.value as Investor)}>
          {INVESTORS.map(([id, name, what]) => (
            <option key={id} value={id}>
              {name} · {what}
            </option>
          ))}
        </select>
      </div>
      <p className="sub sim">
        나와 닮은 투자자: <b>{nameOf(sim)}</b>
        {sim !== inv && (
          <button type="button" className="link" onClick={() => setInv(sim)}>
            이 관점으로
          </button>
        )}
      </p>

      {real ? (
        <>
          {lines && lines.length > 0 ? (
            <ul className="review" aria-live="polite">
              {lines.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          ) : (
            <p className="sub">{busy && review ? 'AI가 포트폴리오를 보는 중…' : `${nameOf(inv)} 관점으로 지금 포트폴리오를 세 줄로 리뷰합니다.`}</p>
          )}
          <button type="button" className="btn sm" onClick={getReview} disabled={busy}>
            {lines ? '다시 리뷰 받기' : '리뷰 받기'}
          </button>
        </>
      ) : (
        <ul className="review">
          {sampleReview(inv, f).map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      {err && <p className="o-warn">{err}</p>}

      {msgs.length > 0 && (
        <div className="msgs" aria-live="polite">
          {msgs.map((m, i) => (
            <p key={i} className={`msg ${m.who}`}>
              {m.text || (busy && i === msgs.length - 1 ? '…' : '')}
            </p>
          ))}
          <div ref={endRef} />
        </div>
      )}
      <form
        className="ask"
        onSubmit={(e) => {
          e.preventDefault();
          ask(text);
        }}
      >
        <label className="sr" htmlFor="ai-ask">
          AI에게 묻기
        </label>
        <input id="ai-ask" value={text} onChange={(e) => setText(e.target.value)} placeholder="AI에게 묻기" maxLength={300} />
        <button type="submit" className="btn pri" disabled={!text.trim() || busy}>
          보내기
        </button>
      </form>
      <div className="suggest">
        {suggest.map((q) => (
          <button key={q} type="button" className="link" onClick={() => ask(q)}>
            {q}
          </button>
        ))}
      </div>
    </section>
  );
}
