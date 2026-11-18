// 예시 데이터. 실제 시세가 아니다. 백엔드(한투 API)를 붙이면 이 파일 대신 서버 도구를 부른다.

export type Stock = {
  code: string;
  name: string;
  sector: string;
  /** 시가총액 (조원) */
  cap: number;
  prev: number;
  price: number;
  // 서버(한투)에서 올 때만 있는 값
  open?: number;
  high?: number;
  low?: number;
  /** 오늘 거래량 (주) */
  vol?: number;
  /** 오늘 거래대금 (원) */
  val?: number;
  per?: number;
  pbr?: number;
  w52h?: number;
  w52l?: number;
  upper?: number;
  lower?: number;
};
export type Index = { id: string; name: string; prev: number; value: number };
export type Holding = {
  code: string;
  qty: number;
  avg: number;
  // 서버(한투 잔고)에서 올 때만 있는 값
  name?: string;
  sector?: string;
  price?: number;
  prev?: number;
  /** 매도가능수량 */
  sellable?: number;
};

// 코드, 이름, 업종, 시가총액(조원), 전일 종가, 현재가 — 코스피 시가총액 상위 50, 보통주만 (P1)
const RAW: [string, string, string, number, number, number][] = [
  ['005930', '삼성전자', '반도체', 425, 70300, 71200],
  ['000660', 'SK하이닉스', '반도체', 133, 183900, 182300],
  ['042700', '한미반도체', '반도체', 9.5, 95700, 98000],
  ['402340', 'SK스퀘어', '반도체', 17, 128000, 130600],
  ['373220', 'LG에너지솔루션', '2차전지·소재', 92, 393000, 392000],
  ['006400', '삼성SDI', '2차전지·소재', 20, 289500, 285000],
  ['051910', 'LG화학', '2차전지·소재', 22, 318500, 312000],
  ['005490', 'POSCO홀딩스', '2차전지·소재', 30, 353000, 351500],
  ['003670', '포스코퓨처엠', '2차전지·소재', 12.5, 166600, 162000],
  ['010130', '고려아연', '2차전지·소재', 16, 812000, 806000],
  ['005380', '현대차', '자동차', 52, 251000, 248000],
  ['000270', '기아', '자동차', 41, 103800, 103200],
  ['012330', '현대모비스', '자동차', 22, 236000, 236500],
  ['207940', '삼성바이오로직스', '바이오', 73, 1028000, 1032000],
  ['068270', '셀트리온', '바이오', 41, 187700, 188900],
  ['000100', '유한양행', '바이오', 9.5, 119000, 118000],
  ['105560', 'KB금융', '금융', 33, 83900, 84700],
  ['055550', '신한지주', '금융', 28, 55000, 55800],
  ['138040', '메리츠금융지주', '금융', 21, 109700, 112000],
  ['086790', '하나금융지주', '금융', 19, 65700, 66900],
  ['032830', '삼성생명', '금융', 19, 96200, 96500],
  ['000810', '삼성화재', '금융', 17, 359000, 362000],
  ['316140', '우리금융지주', '금융', 12, 16120, 16300],
  ['024110', '기업은행', '금융', 11, 14520, 14600],
  ['323410', '카카오뱅크', '금융', 11, 22900, 22600],
  ['012450', '한화에어로스페이스', '조선·방산·기계', 26, 499000, 512000],
  ['329180', 'HD현대중공업', '조선·방산·기계', 26, 289000, 298000],
  ['042660', '한화오션', '조선·방산·기계', 22, 68400, 71300],
  ['009540', 'HD한국조선해양', '조선·방산·기계', 15, 214000, 219500],
  ['010140', '삼성중공업', '조선·방산·기계', 12, 13050, 13400],
  ['034020', '두산에너빌리티', '조선·방산·기계', 16, 24400, 24850],
  ['064350', '현대로템', '조선·방산·기계', 11, 101500, 104800],
  ['035420', 'NAVER', '인터넷·게임', 34, 213500, 214500],
  ['035720', '카카오', '인터넷·게임', 18, 40400, 41350],
  ['259960', '크래프톤', '인터넷·게임', 16, 337000, 341000],
  ['066570', 'LG전자', '전자·IT', 16, 97900, 98300],
  ['009150', '삼성전기', '전자·IT', 11, 149200, 151000],
  ['018260', '삼성에스디에스', '전자·IT', 11, 141000, 142300],
  ['028260', '삼성물산', '지주', 28, 157000, 158000],
  ['003550', 'LG', '지주', 12.5, 78900, 79400],
  ['017670', 'SK텔레콤', '통신', 12, 56200, 56100],
  ['030200', 'KT', '통신', 11, 44300, 44350],
  ['096770', 'SK이노베이션', '에너지·유틸리티', 16, 110300, 108900],
  ['010950', 'S-Oil', '에너지·유틸리티', 7, 61600, 61200],
  ['015760', '한국전력', '에너지·유틸리티', 14, 21350, 21200],
  ['033780', 'KT&G', '소비재', 13, 104000, 104500],
  ['090430', '아모레퍼시픽', '소비재', 7, 126100, 124300],
  ['003230', '삼양식품', '소비재', 5.5, 712000, 725000],
  ['011200', 'HMM', '운송', 13, 19350, 18950],
  ['003490', '대한항공', '운송', 8, 22200, 22350],
];

export const STOCKS: Stock[] = RAW.map(([code, name, sector, cap, prev, price]) => ({ code, name, sector, cap, prev, price }));
export const STOCK_BY_CODE = new Map(STOCKS.map((s) => [s.code, s]));

export const INDICES: Index[] = [
  { id: 'kospi', name: '코스피', prev: 2619.3, value: 2641.32 },
  { id: 'kosdaq', name: '코스닥', prev: 748.1, value: 743.85 },
  { id: 'usdkrw', name: '원/달러', prev: 1384.5, value: 1381.2 },
];

export const HOLDINGS: Holding[] = [
  { code: '005930', qty: 80, avg: 68900 },
  { code: '000660', qty: 20, avg: 175400 },
  { code: '035720', qty: 50, avg: 43100 },
  { code: '005380', qty: 10, avg: 235000 },
  { code: '035420', qty: 8, avg: 198000 },
  { code: '105560', qty: 30, avg: 79500 },
];
export const CASH = 2_150_000;

/** 한국거래소 호가 단위 */
export function tickOf(p: number): number {
  if (p < 2000) return 1;
  if (p < 5000) return 5;
  if (p < 20000) return 10;
  if (p < 50000) return 50;
  if (p < 200000) return 100;
  if (p < 500000) return 500;
  return 1000;
}

/** 예시 거래량·거래대금. 종목 코드로 늘 같은 값을 만든다 (실제 값은 한투 시세·일봉으로 바꾼다). */
export type Trade = { vol: [number, number, number]; val: [number, number, number] };
function rand(seed: string, salt: number) {
  let h = 2166136261 ^ salt;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}
export function sampleTrade(s: Stock): Trade {
  // 하루 회전율 0.1% ~ 1.5% (시가총액 대비 거래대금)
  const turn = 0.001 + rand(s.code, 1) * 0.014;
  const day = s.cap * 1e12 * turn;
  const week = day * 5 * (0.7 + rand(s.code, 2) * 0.6);
  const month = week * 4.2 * (0.7 + rand(s.code, 3) * 0.6);
  const val: [number, number, number] = [day, week, month];
  return { val, vol: val.map((v) => Math.round(v / s.price)) as [number, number, number] };
}

// ---------- 종목 페이지 예시 데이터 (실제는 한투 기간별 시세·호가로 바꾼다) ----------
export type Candle = { t: string; o: number; h: number; l: number; c: number; v: number };
const roundTick = (p: number) => Math.max(1, Math.round(p / tickOf(p)) * tickOf(p));

/** 최근 거래일 n개 날짜 (주말 뺌, 공휴일은 아직 안 뺌). 마지막이 오늘 */
function tradingDays(n: number): Date[] {
  const out: Date[] = [];
  const d = new Date();
  while (out.length < n) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) out.unshift(new Date(d));
    d.setDate(d.getDate() - 1);
  }
  return out;
}
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 일봉 260개 (약 1년). 종목마다 늘 같은 모양이고, 오늘 봉은 지금 가격으로 끝난다 */
export function sampleDaily(s: Stock): Candle[] {
  const days = tradingDays(260);
  let seed = 0;
  for (const ch of s.code) seed = (seed * 31 + ch.charCodeAt(0)) % 233280;
  const r = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const baseVol = sampleTrade(s).vol[0];
  // 전일 종가에서 거꾸로 걸어가며 과거 값을 만든다
  const closes: number[] = [s.prev];
  for (let i = 1; i < days.length - 1; i++) closes.unshift(closes[0] / (1 + (r() - 0.48) * 0.04));
  const out: Candle[] = [];
  for (let i = 0; i < days.length - 1; i++) {
    const c = closes[i];
    const o = i ? closes[i - 1] * (1 + (r() - 0.5) * 0.01) : c * (1 + (r() - 0.5) * 0.02);
    const h = Math.max(o, c) * (1 + r() * 0.012);
    const l = Math.min(o, c) * (1 - r() * 0.012);
    out.push({ t: ymd(days[i]), o: roundTick(o), h: roundTick(h), l: roundTick(l), c: roundTick(c), v: Math.round(baseVol * (0.5 + r())) });
  }
  const o = roundTick(s.prev * (1 + (r() - 0.5) * 0.008));
  out.push({ t: ymd(days[days.length - 1]), o, h: Math.max(o, s.price, roundTick(s.price * 1.004)), l: Math.min(o, s.price, roundTick(s.price * 0.995)), c: s.price, v: baseVol });
  return out;
}

/** 일봉을 주봉(5일)·월봉(21일)으로 묶는다 */
export function groupCandles(d: Candle[], size: number): Candle[] {
  const out: Candle[] = [];
  for (let end = d.length; end > 0; end -= size) {
    const g = d.slice(Math.max(0, end - size), end);
    out.unshift({ t: g[0].t, o: g[0].o, c: g[g.length - 1].c, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), v: g.reduce((a, x) => a + x.v, 0) });
  }
  return out;
}

/** 호가 10단계. asks 는 위(비싼 쪽)부터, bids 는 현재가부터 아래로 */
export function sampleBook(s: Stock): { asks: { p: number; q: number }[]; bids: { p: number; q: number }[] } {
  const base = sampleTrade(s).vol[0] / 400;
  let seed = Math.round(s.price) % 9973;
  const r = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const asks: { p: number; q: number }[] = [];
  const bids: { p: number; q: number }[] = [];
  let a = s.price;
  for (let i = 0; i < 10; i++) {
    a += tickOf(a);
    asks.unshift({ p: a, q: Math.round(base * (0.3 + r() * 1.4)) });
  }
  let b = s.price;
  for (let i = 0; i < 10; i++) {
    bids.push({ p: b, q: Math.round(base * (0.3 + r() * 1.4)) });
    b -= tickOf(b - 1);
  }
  return { asks, bids };
}

/** 상한가·하한가 (전일 종가 ±30%, 호가 단위로) */
export function priceLimits(prev: number) {
  const up = prev * 1.3;
  const dn = prev * 0.7;
  return { upper: Math.floor(up / tickOf(up)) * tickOf(up), lower: Math.ceil(dn / tickOf(dn)) * tickOf(dn) };
}
