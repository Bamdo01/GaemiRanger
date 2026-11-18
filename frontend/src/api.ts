import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

// 서버(FastAPI) 연결. GitHub Pages 처럼 서버가 없으면 예시 데이터로 돈다.
export type ServerStatus = {
  server: boolean;
  loggedIn: boolean;
  loginReady: boolean;
  kis: { configured: boolean; mode: string; lastOk: number | null; lastError: string | null } | null;
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

/** live 일 때만 path 를 ms 마다 받아 온다 */
export function usePoll<T>(path: string | null, ms: number): { data: T | null; error: string; at: number } {
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
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [path, ms]);
  return state;
}
