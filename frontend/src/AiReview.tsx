import { useEffect, useRef, useState } from 'react';
import { changeText, fmt, signPct } from './lib';
import type { Portfolio } from './portfolio';

// AI 리뷰 (매거진 안). 숫자 점검은 AI 없이 계산한 진짜 값이고, 리뷰 글과 채팅 답은 AI 연결 전 예시다.
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

type Facts = ReturnType<typeof factsOf>;
function factsOf(port: Portfolio, kospiPct: number) {
  const top = [...port.rows].sort((a, b) => b.amt - a.amt)[0];
  const sectors = new Map<string, number>();
  port.rows.forEach((r) => sectors.set(r.s.sector, (sectors.get(r.s.sector) ?? 0) + r.amt));
  const [topSector, topSectorAmt] = [...sectors].sort((a, b) => b[1] - a[1])[0];
  const losers = port.rows.filter((r) => r.profit < 0).sort((a, b) => a.profit - b.profit);
  return {
    n: port.rows.length,
    top,
    topPct: (top.amt / port.total) * 100,
    topSector,
    topSectorPct: (topSectorAmt / port.total) * 100,
    sectorCount: sectors.size,
    cashPct: (port.cash / port.total) * 100,
    losers,
    vsKospi: port.todayPct - kospiPct,
    kospiPct,
    port,
  };
}

/** AI 없이 계산하는 점검. level: ok / warn */
function checks(f: Facts): { label: string; value: string; note: string; level: 'ok' | 'warn' }[] {
  return [
    { label: '가장 큰 종목', value: `${f.top.s.name} ${f.topPct.toFixed(1)}%`, note: '총자산 대비. 25% 넘으면 표시', level: f.topPct > 25 ? 'warn' : 'ok' },
    { label: '가장 큰 업종', value: `${f.topSector} ${f.topSectorPct.toFixed(1)}%`, note: '총자산 대비. 40% 넘으면 표시', level: f.topSectorPct > 40 ? 'warn' : 'ok' },
    { label: '현금', value: `${f.cashPct.toFixed(1)}%`, note: '5% 아래면 표시', level: f.cashPct < 5 ? 'warn' : 'ok' },
    {
      label: '손실 중인 종목',
      value: f.losers.length ? f.losers.map((r) => `${r.s.name} ${signPct(r.profit)}`).join(', ') : '없음',
      note: '평균단가 대비',
      level: f.losers.length ? 'warn' : 'ok',
    },
    { label: '오늘 코스피 대비', value: `${f.vsKospi >= 0 ? '+' : ''}${f.vsKospi.toFixed(2)}%p`, note: `내 주식 ${changeText(f.port.todayPct)}, 코스피 ${changeText(f.kospiPct)}`, level: f.vsKospi < 0 ? 'warn' : 'ok' },
  ];
}

/** 예시 리뷰 글. AI가 연결되면 서버가 만든 글로 바뀐다. */
function sampleReview(inv: Investor, f: Facts): string[] {
  const loser = f.losers[0];
  const loserLine = loser ? `${loser.s.name}(${signPct(loser.profit)})` : '손실 종목';
  switch (inv) {
    case 'buffett':
      return [
        `${f.n}종목에 ${f.topSector} 비중이 ${f.topSectorPct.toFixed(0)}%입니다. 버핏 관점에서 몰아서 들고 있는 것 자체는 문제가 아닙니다. 그 기업들이 10년 뒤에도 경쟁력이 있다고 확신하는지가 핵심입니다.`,
        `${loserLine}은 가격보다 "처음 산 이유가 아직 맞는가"를 다시 적어 보라고 할 것입니다. 이유가 그대로면 기다리고, 바뀌었으면 정리하는 쪽입니다.`,
        `앞으로: 새로 살 때는 사업을 한 문장으로 설명할 수 있는 기업만, 그리고 오래 들고 갈 생각으로.`,
      ];
    case 'graham':
      return [
        `그레이엄은 10~30종목 분산을 권했습니다. ${f.n}종목은 그 기준보다 적고, ${f.top.s.name} 한 종목이 ${f.topPct.toFixed(0)}%입니다.`,
        `안전마진을 보려면 PER, PBR, 부채비율이 필요합니다. 종목 정보(S4)가 연결되면 지금 가격이 가치보다 싼지 종목마다 확인할 수 있습니다.`,
        `앞으로: 사기 전에 "얼마면 싸다"는 가격을 먼저 정하고, 그 아래에서만 사는 조건부 매수 규칙(R2)과 잘 맞습니다.`,
      ];
    case 'lynch':
      return [
        `린치는 보유 종목을 유형으로 나눠 보라고 합니다. 저성장, 우량, 고성장, 경기순환, 회생, 자산주. 지금 ${f.n}종목이 각각 어디에 속하는지 적어 보면 기대 수익과 팔 때가 달라집니다.`,
        `${loserLine}은 "2분 안에 이 종목을 왜 갖고 있는지 설명할 수 있나"부터 확인할 것입니다.`,
        `앞으로: 내가 쓰고 잘 아는 회사 중에서 이익이 꾸준히 느는데 주가가 덜 오른 곳을 찾는 방식.`,
      ];
    case 'bogle':
      return [
        `보글 관점의 첫 질문은 "지수보다 나은가"입니다. 오늘은 코스피보다 ${f.vsKospi >= 0 ? '앞섰' : '뒤졌'}습니다(${f.vsKospi >= 0 ? '+' : ''}${f.vsKospi.toFixed(2)}%p). 하루가 아니라 1년 이상 비교해야 의미가 있습니다.`,
        `개별 종목 ${f.n}개는 시장 전체보다 위험이 큽니다. 보글이라면 핵심은 지수 ETF로 두고, 고르고 싶은 종목은 작은 비중으로만 두라고 할 것입니다.`,
        `앞으로: 매매를 줄이고 수수료와 세금을 아끼는 쪽.`,
      ];
    case 'dalio':
      return [
        `주식 ${(100 - f.cashPct).toFixed(0)}%, 현금 ${f.cashPct.toFixed(0)}%이고 채권이나 금은 없습니다. 달리오 관점에서는 경기가 좋을 때만 잘 되는 구성입니다.`,
        `${f.topSector}처럼 같은 경기에 함께 움직이는 종목이 많으면 종목 수가 많아도 분산 효과가 작습니다.`,
        `앞으로: 경기 상황(성장·물가)이 바뀌어도 크게 흔들리지 않도록 서로 다르게 움직이는 자산을 섞는 쪽.`,
      ];
  }
}

/** 보유 구성만 보고 고른 닮은 투자자 (매매 습관은 체결 내역 연결 후) */
function similar(f: Facts): { inv: Investor; why: string } {
  if (f.n <= 8 && f.topPct >= 20) return { inv: 'buffett', why: `종목 ${f.n}개에 큰 종목 비중이 높아 "좋은 기업에 몰아서"에 가깝습니다.` };
  if (f.n >= 20) return { inv: 'bogle', why: `종목이 ${f.n}개로 넓게 나눠 갖고 있어 분산에 가깝습니다.` };
  return { inv: 'lynch', why: '여러 업종의 아는 기업을 골라 담은 구성에 가깝습니다.' };
}

const nameOf = (i: Investor) => INVESTORS.find(([x]) => x === i)![1];

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

  const f = factsOf(port, kospiPct);
  const sim = similar(f);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ block: 'nearest' }), [msgs]);

  const ask = (q: string) => {
    const t = q.trim();
    if (!t) return;
    setMsgs((m) => [
      ...m,
      { who: 'me', text: t },
      { who: 'ai', text: `예시 답변입니다. AI가 연결되면 위 리뷰와 지금 포트폴리오(총자산 ${fmt(port.total)}원, ${f.n}종목)를 바탕으로 ${nameOf(inv)} 관점에서 이 질문에 답합니다.` },
    ]);
    setText('');
  };
  const suggest = [
    `${nameOf(inv)} 관점에서 ${f.losers[0]?.s.name ?? f.top.s.name} 보유는 어떻게 볼까?`,
    `${f.topSector} 비중을 줄여야 할까?`,
    '현금은 얼마나 두는 게 좋을까?',
  ];

  return (
    <section className="card ai" aria-labelledby="h-ai">
      <div className="card-head">
        <h2 id="h-ai">AI 리뷰</h2>
        <span className="tag">리뷰 글과 채팅 답은 예시 · AI 연결 전</span>
      </div>

      <div className="ai-cols">
        <div>
          <h3>숫자 점검</h3>
          <p className="sub">AI 없이 계산한 값</p>
          <ul className="checks">
            {checks(f).map((c) => (
              <li key={c.label} className={c.level}>
                <span className="ck-mark" aria-hidden="true">
                  {c.level === 'warn' ? '!' : '✓'}
                </span>
                <span className="ck-label">{c.label}</span>
                <b>{c.value}</b>
                <small>{c.note}</small>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3>투자자 관점</h3>
          <div className="seg inv" role="group" aria-label="투자자 관점">
            {INVESTORS.map(([id, name]) => (
              <button key={id} type="button" aria-pressed={inv === id} onClick={() => setInv(id)}>
                {name}
              </button>
            ))}
          </div>
          <p className="sub">{INVESTORS.find(([x]) => x === inv)![2]}</p>
          <div className="review">
            {sampleReview(inv, f).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
          <div className="ai-row">
            <div className="mini-box">
              <h4>지난 매매 돌아보기</h4>
              <p>체결 내역이 연결되면 일찍 판 종목, 늦은 손절 같은 아쉬운 점을 정리합니다.</p>
            </div>
            <div className="mini-box">
              <h4>나와 닮은 투자자</h4>
              <p>
                <b>{nameOf(sim.inv)}</b> · {sim.why} 매매 습관은 체결 내역 연결 후 반영합니다.
              </p>
              {sim.inv !== inv && (
                <button type="button" className="btn sm" onClick={() => setInv(sim.inv)}>
                  {nameOf(sim.inv)} 관점으로 보기
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="chat" aria-label="AI와 채팅">
        <h3>이어서 묻기</h3>
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
        <div className="chips">
          {suggest.map((q) => (
            <button key={q} type="button" className="chip" onClick={() => ask(q)}>
              {q}
            </button>
          ))}
        </div>
        <form
          className="ask"
          onSubmit={(e) => {
            e.preventDefault();
            ask(text);
          }}
        >
          <label className="sr" htmlFor="ai-ask">
            AI에게 질문
          </label>
          <input id="ai-ask" value={text} onChange={(e) => setText(e.target.value)} placeholder="리뷰를 보고 궁금한 것을 물어보세요" maxLength={300} />
          <button type="submit" className="btn pri" disabled={!text.trim()}>
            보내기
          </button>
        </form>
      </div>
    </section>
  );
}
