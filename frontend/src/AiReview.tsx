import { useEffect, useRef, useState } from 'react';
import { fmt, signPct } from './lib';
import { checksOf, type Facts, type Portfolio } from './portfolio';

// AI 리뷰. 리뷰 글과 채팅 답은 AI 연결 전 예시다. 숫자는 점검 칸과 같은 계산(checksOf)을 쓴다.
// 진짜 연결 때: /api/review, /api/chat (Claude 연결 방식은 PLAN.md D6).

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
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [msgs]);

  const ask = (q: string) => {
    const t = q.trim();
    if (!t) return;
    setMsgs((m) => [
      ...m,
      { who: 'me', text: t },
      { who: 'ai', text: `(예시 답변) AI가 연결되면 지금 포트폴리오(총자산 ${fmt(port.total)}원, ${f.n}종목)를 바탕으로 ${nameOf(inv)} 관점에서 답합니다.` },
    ]);
    setText('');
  };
  const suggest = [`${f.topSector} 비중을 줄여야 할까?`, '현금은 얼마나 두는 게 좋을까?'];

  return (
    <section className="card ai" aria-labelledby="h-ai">
      <div className="card-head">
        <h2 id="h-ai">AI 리뷰</h2>
        <span className="sub">예시 · AI 연결 전</span>
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

      <ul className="review">
        {sampleReview(inv, f).map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>

      {msgs.length > 0 && (
        <div className="msgs" aria-live="polite">
          {msgs.map((m, i) => (
            <p key={i} className={`msg ${m.who}`}>
              {m.text}
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
        <button type="submit" className="btn pri" disabled={!text.trim()}>
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
