"""실시간 시세: 한투 웹소켓(국내 체결·호가, 해외 체결)과 업비트 웹소켓(코인).

- 2026-11-22 확인: 한투 모의 웹소켓 ws://ops.koreainvestment.com:31000, 등록은 41자리까지 (42번째 MAX SUBSCRIBE OVER)
- 41자리는 순서대로 나눈다 (사용자 결정): ① 지금 보고 있는 종목(체결+호가) ② 보유 종목(한투, 수기 국내·해외) ③ (봇 단계) 규칙 종목 ④ 남는 자리
- 시장 히트맵의 나머지는 지금처럼 조회(REST)로 돈다. 자리가 넘친 보유 종목도 조회로 받고 화면에 알린다
- 받은 값은 market.quotes / prices.overseas / prices.coins 캐시를 바로 고치고, 화면에는 /api/stream 으로 알린다
- 업비트는 연결 하나에 여러 코인을 등록할 수 있어 가진 코인 전부를 받는다
"""

import asyncio
import json
import time

import httpx
import websockets

from . import config, market, prices

KIS_WS = "ws://ops.koreainvestment.com:31000"  # 모의
UPBIT_WS = "wss://api.upbit.com/websocket/v1"
SLOTS = 41
# 해외 실시간 키: D + 거래소 + 티커 (모의에서 등록 확인. 지연 여부는 미국장이 열릴 때 확인)
US_PREFIX = {"NAS": "DNAS", "NYS": "DNYS", "AMS": "DAMS"}

viewing: dict[str, float] = {}  # 종목코드 → 마지막으로 화면이 본 시각
books: dict[str, dict] = {}  # 종목코드 → 실시간 호가
state = {"kis": "off", "upbit": "off", "overflow": [], "slots": 0, "lastTick": 0.0}
_version = 0  # 실시간 값이 바뀔 때마다 1씩 (화면 알림 /api/stream 이 본다)


def _bump() -> None:
    global _version
    _version += 1
    state["lastTick"] = time.time()


def version() -> int:
    return _version


def see(code: str) -> None:
    """화면이 이 종목을 보고 있다 (/api/stock/{code} 가 부른다)"""
    viewing[code] = time.time()


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# ---------- 41자리 나누기 ----------
def wanted() -> tuple[list[tuple[str, str]], list[str]]:
    """등록할 (tr_id, tr_key) 목록과 자리가 없어 빠진 종목"""
    from . import ledger

    now = time.time()
    out: list[tuple[str, str]] = []
    for c in sorted(viewing, key=lambda c: -viewing[c]):
        if now - viewing[c] < 30:
            out += [("H0STCNT0", c), ("H0STASP0", c)]
    held_kr = [h["code"] for h in market.balance.get("holdings", [])] + ledger.kr_codes()
    out += [("H0STCNT0", c) for c in held_kr]
    from . import rules  # 규칙 종목은 보유 다음 순서

    out += [("H0STCNT0", c) for c in rules.codes()]
    for s in ledger.symbols("us"):
        ex = prices._excd.get(s)
        if ex:  # 거래소를 아직 모르면 조회가 먼저 찾는다
            out.append(("HDFSCNT0", US_PREFIX[ex] + s))
    seen, uniq = set(), []
    for x in out:
        if x not in seen:
            seen.add(x)
            uniq.append(x)
    return uniq[:SLOTS], list(dict.fromkeys(k for _, k in uniq[SLOTS:]))


# ---------- 받은 값 반영 ----------
def _on_kr_trade(f: list[str]) -> None:
    code, price = f[0], int(_f(f[2]))
    if not price:
        return
    diff = abs(_f(f[4])) * (-1 if f[3] in ("4", "5") else 1)
    q = market.quotes.get(code) or {"code": code, "name": code, "sector": "기타", "cap": 0}
    q.update(price=price, prev=int(price - diff), open=int(_f(f[7])), high=int(_f(f[8])), low=int(_f(f[9])), vol=int(_f(f[13])), val=int(_f(f[14])), at=time.time(), live=True)
    market.quotes[code] = q


def _on_kr_book(f: list[str]) -> None:
    code = f[0]
    asks = [{"p": int(_f(f[3 + i])), "q": int(_f(f[23 + i]))} for i in range(9, -1, -1)]
    bids = [{"p": int(_f(f[13 + i])), "q": int(_f(f[33 + i]))} for i in range(10)]
    books[code] = {"asks": [a for a in asks if a["p"]], "bids": [b for b in bids if b["p"]], "at": time.time(), "live": True}


def _on_us_trade(f: list[str]) -> None:
    sym, last = f[1], _f(f[11])
    if not last:
        return
    diff = abs(_f(f[13])) * (-1 if f[12] in ("4", "5") else 1)
    old = prices.overseas.get(sym, {})
    prices.overseas[sym] = {"price": last, "prev": last - diff if diff else old.get("prev", last), "excd": old.get("excd", ""), "at": time.time(), "live": True}


# 한 묶음의 필드 수는 받은 글자를 건수로 나눠 구한다
HANDLERS = {"H0STCNT0": (_on_kr_trade, 0), "H0STASP0": (_on_kr_book, 0), "HDFSCNT0": (_on_us_trade, 0)}


def _on_frame(m: str) -> None:
    # "0|H0STCNT0|003|필드^필드^..." (암호화 안 된 실시간 데이터, 건수만큼 이어 붙음)
    parts = m.split("|", 3)
    if len(parts) < 4:
        return
    tr, n, body = parts[1], int(parts[2] or 1), parts[3].split("^")
    h = HANDLERS.get(tr)
    if not h:
        return
    fn, width = h
    width = width or len(body) // max(n, 1)
    for i in range(max(n, 1)):
        rec = body[i * width : (i + 1) * width] if n > 1 else body
        if rec:
            fn(rec)
    _bump()


# ---------- 한투 웹소켓 ----------
async def _approval() -> str:
    async with httpx.AsyncClient(base_url=config.KIS_BASE, timeout=10) as h:
        r = await h.post("/oauth2/Approval", json={"grant_type": "client_credentials", "appkey": config.KIS_APP_KEY, "secretkey": config.KIS_APP_SECRET})
        return r.json().get("approval_key", "")


def _msg(key: str, tr: str, k: str, on: bool) -> str:
    return json.dumps({"header": {"approval_key": key, "custtype": "P", "tr_type": "1" if on else "2", "content-type": "utf-8"}, "body": {"input": {"tr_id": tr, "tr_key": k}}})


async def kis_forever() -> None:
    while True:
        if not config.kis_configured():
            await asyncio.sleep(30)
            continue
        try:
            key = await _approval()
            if not key:
                raise RuntimeError("접속키를 받지 못했습니다")
            async with websockets.connect(KIS_WS, open_timeout=10, ping_interval=None, max_queue=4096) as ws:
                state["kis"] = "on"
                active: set[tuple[str, str]] = set()

                async def sync() -> None:
                    want, over = wanted()
                    state["overflow"], state["slots"] = over, len(want)
                    ws_want = set(want)
                    for x in active - ws_want:
                        await ws.send(_msg(key, x[0], x[1], False))
                        active.discard(x)
                    for x in want:
                        if x not in active:
                            await ws.send(_msg(key, x[0], x[1], True))
                            active.add(x)

                async def syncer() -> None:
                    while True:
                        await sync()
                        await asyncio.sleep(2)

                task = asyncio.create_task(syncer())
                try:
                    async for m in ws:
                        if isinstance(m, bytes):
                            m = m.decode()
                        if m[:1] in ("0", "1"):
                            _on_frame(m)
                            continue
                        try:
                            d = json.loads(m)
                        except ValueError:
                            continue
                        if d.get("header", {}).get("tr_id") == "PINGPONG":
                            await ws.send(m)
                        elif d.get("body", {}).get("msg_cd") == "OPSP0008":  # 자리 넘침 (계산이 어긋났을 때)
                            h = d.get("header", {})
                            active.discard((h.get("tr_id"), h.get("tr_key")))
                finally:
                    task.cancel()
        except Exception as e:  # noqa: BLE001 - 끊기면 잠깐 쉬고 다시
            state["kis"] = f"끊김: {e.__class__.__name__}"
        await asyncio.sleep(5)


# ---------- 업비트 웹소켓 ----------
async def upbit_forever() -> None:
    from . import ledger

    while True:
        coins = sorted(ledger.symbols("coin"))
        if not coins:
            state["upbit"] = "off"
            await asyncio.sleep(10)
            continue
        try:
            async with websockets.connect(UPBIT_WS, open_timeout=10, ping_interval=30) as ws:
                await ws.send(json.dumps([{"ticket": "gaemiranger"}, {"type": "ticker", "codes": [f"KRW-{c}" for c in coins]}]))
                state["upbit"] = "on"
                started = time.time()
                async for m in ws:
                    d = json.loads(m)
                    code = str(d.get("code", ""))[4:]
                    if code:
                        prices.coins[code] = {"price": _f(d.get("trade_price")), "prev": _f(d.get("prev_closing_price")), "at": time.time(), "live": True}
                        _bump()
                    # 가진 코인이 바뀌면 다시 연결해 새로 등록
                    if time.time() - started > 10 and sorted(ledger.symbols("coin")) != coins:
                        break
        except Exception as e:  # noqa: BLE001
            state["upbit"] = f"끊김: {e.__class__.__name__}"
        await asyncio.sleep(3)


def live_fresh(at: float | None, sec: float = 5) -> bool:
    return bool(at) and time.time() - at < sec
