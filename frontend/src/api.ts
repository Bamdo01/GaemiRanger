import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

// 서버(FastAPI) 연결. GitHub Pages 처럼 서버가 없으면 예시 데이터로 돈다.
export type ServerStatus = {
  server: boolean;
  loggedIn: boolean;
  loginReady: boolean;
  /** 텔레그램 승인이 켜져 있음 */
  telegram?: boolean;
  /** 남은 복구 코드가 있음 */
  recovery?: boolean;
  kis: { configured: boolean; mode: string; lastOk: number | null; lastError: string | null; limits?: { orderLimit: number; allowMarket: boolean; emergency: boolean } } | null;
  marketOpen: boolean;
};
const OFFLINE: ServerStatus = { server: false, loggedIn: false, loginReady: false, kis: null, marketOpen: false };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = '',
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError(0, '서버에 연결하지 못했습니다');
  }
  const isJson = (r.headers.get('content-type') ?? '').includes('application/json');
  const body = isJson ? await r.json().catch(() => null) : null;
  if (!r.ok || !isJson) {
    const d = body?.detail;
    const msg = typeof d === 'string' ? d : d?.msg ?? `HTTP ${r.status}`;
    throw new ApiError(r.status, msg, typeof d === 'object' ? d?.code ?? '' : '');
  }
  return body as T;
}
export const post = <T,>(path: string, data: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const put = <T,>(path: string, data: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(data) });
export const del = <T,>(path: string) => api<T>(path, { method: 'DELETE' });

type Ctx = { status: ServerStatus; live: boolean; checked: boolean; refresh: () => Promise<void> };
const ServerCtx = createContext<Ctx>({ status: OFFLINE, live: false, checked: false, refresh: async () => undefined });

export function ServerProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ServerStatus>(OFFLINE);
  const [checked, setChecked] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setStatus(await api<ServerStatus>('/api/status'));
    } catch {
      setStatus(OFFLINE); // 서버가 없음 (GitHub Pages 등) → 예시 데이터
    }
    setChecked(true);
  }, []);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [refresh]);
  const live = status.server && status.loggedIn && !!status.kis?.configured;
  return createElement(ServerCtx.Provider, { value: { status, live, checked, refresh } }, children);
}
export const useServer = () => useContext(ServerCtx);
/** 실전(real)인지 모의(mock)인지. 문구와 경고를 바꿀 때 */
export function useMode() {
  const { status } = useServer();
  const real = status.kis?.mode === 'real';
  return { real, name: real ? '실전' : '모의투자' };
}

const REFRESH_EVENT = 'gr-refresh';
// 서버가 실시간 시세를 받았다고 알려 올 때 (/api/stream). live 로 등록한 usePoll 만 다시 받는다
const LIVE_EVENT = 'gr-live';
/** 받아 오고 있는 모든 값을 지금 다시 받는다 (수기 기록을 바꾼 뒤) */
export const refreshAll = () => window.dispatchEvent(new Event(REFRESH_EVENT));

/** live 일 때만 path 를 ms 마다 받아 온다. onLive 면 실시간 알림이 올 때도 바로 다시 받는다 */
export function usePoll<T>(path: string | null, ms: number, onLive = false): { data: T | null; error: string; at: number } {
  const [state, setState] = useState<{ data: T | null; error: string; at: number }>({ data: null, error: '', at: 0 });
  const pathRef = useRef(path);
  pathRef.current = path;
  useEffect(() => {
    setState({ data: null, error: '', at: 0 });
    if (!path) return;
    let alive = true;
    const load = async () => {
      try {
        const d = await api<T>(path);
        if (alive && pathRef.current === path) setState({ data: d, error: '', at: Date.now() });
      } catch (e) {
        if (alive && pathRef.current === path) setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      }
    };
    load();
    const id = setInterval(load, ms);
    // 기록을 바꾸면 refreshAll() 로 바로 다시 받는다
    window.addEventListener(REFRESH_EVENT, load);
    if (onLive) window.addEventListener(LIVE_EVENT, load);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener(REFRESH_EVENT, load);
      window.removeEventListener(LIVE_EVENT, load);
    };
  }, [path, ms, onLive]);
  return state;
}

/* ---------- 실시간 알림 (서버 → 화면) ---------- */
export type Stream = { connected: boolean; at: number; kis: string; upbit: string; overflow: number; rulesPending: number };
const OFF: Stream = { connected: false, at: 0, kis: 'off', upbit: 'off', overflow: 0, rulesPending: 0 };
const StreamCtx = createContext<Stream>(OFF);

/** 로그인·한투 연결이 되어 있으면 /api/stream 을 열어 두고, 알림이 오면 live usePoll 들을 다시 받게 한다 */
export function StreamProvider({ children }: { children: ReactNode }) {
  const { live } = useServer();
  const [st, setSt] = useState<Stream>(OFF);
  useEffect(() => {
    if (!live || typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        setSt({ connected: true, at: (d.at ?? 0) * 1000, kis: d.kis, upbit: d.upbit, overflow: d.overflow ?? 0, rulesPending: d.rulesPending ?? 0 });
        window.dispatchEvent(new Event(LIVE_EVENT));
      } catch {
        /* 무시 */
      }
    };
    es.onopen = () => setSt((s) => ({ ...s, connected: true }));
    es.onerror = () => setSt((s) => ({ ...s, connected: false })); // 브라우저가 알아서 다시 붙는다
    return () => es.close();
  }, [live]);
  return createElement(StreamCtx.Provider, { value: st }, children);
}
export const useStream = () => useContext(StreamCtx);
