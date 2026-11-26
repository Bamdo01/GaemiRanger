"""GaemiRanger 서버. 실행: .venv\\Scripts\\python -m uvicorn app.main:app --port 8000

- 모든 /api 는 로그인이 필요하다 (/api/status, /api/login 제외).
- 한투 키가 없으면 503(NOT_CONFIGURED)을 돌려주고, 화면은 예시 데이터를 쓴다.
- frontend/dist 가 있으면 화면도 같이 내보낸다 (같은 주소라 쿠키 로그인이 그대로 된다).
"""

import asyncio
import functools
import json
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import activity, ai, alerts, ants, auth, evolve, guard, config, harness, ledger, market, orders, prices, realtime, rules, settings, telegram, views
from .kis import URGENT, KISError, kis
from .universe import UNIVERSE


@asynccontextmanager
async def lifespan(_: FastAPI):
    tasks = [
        asyncio.create_task(market.poll_forever()), asyncio.create_task(telegram.poll_forever()), asyncio.create_task(prices.poll_forever()),
        asyncio.create_task(realtime.kis_forever()),
        asyncio.create_task(realtime.upbit_forever()),
        asyncio.create_task(rules.run_forever()),
        asyncio.create_task(alerts.run_forever()),
        asyncio.create_task(guard.run_forever()),
        asyncio.create_task(harness.run_forever()),
    ]
    yield
    for t in tasks:
        t.cancel()
    await alerts.close()
    await kis.close()
    await telegram.close()
    await prices.close()


app = FastAPI(title="GaemiRanger", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


class UrgentApi:
    """화면이 부른 /api 요청 안의 한투 호출은 백그라운드 갱신보다 먼저 보낸다"""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"].startswith("/api/"):
            tok = URGENT.set(True)
            try:
                await self.inner(scope, receive, send)
            finally:
                URGENT.reset(tok)
        else:
            await self.inner(scope, receive, send)


app.add_middleware(UrgentApi)


@app.middleware("http")
async def security_headers(req: Request, call_next):
    res = await call_next(req)
    res.headers["X-Content-Type-Options"] = "nosniff"
    res.headers["X-Frame-Options"] = "DENY"
    res.headers["Referrer-Policy"] = "same-origin"
    if req.url.path.startswith("/api"):
        res.headers["Cache-Control"] = "no-store"
    if config.COOKIE_SECURE:  # HTTPS 로 연 서버: 브라우저가 앞으로도 HTTPS 로만 오게
        res.headers["Strict-Transport-Security"] = "max-age=31536000"
    return res


def need_kis() -> None:
    if not config.kis_configured():
        raise HTTPException(503, detail={"code": "NOT_CONFIGURED", "msg": "한투 키가 아직 설정되지 않았습니다"})


def kis_errors(fn):
    @functools.wraps(fn)
    async def wrap(*a, **k):
        try:
            return await fn(*a, **k)
        except KISError as e:
            raise HTTPException(502, detail={"code": e.code or "KIS", "msg": str(e)}) from e

    return wrap


# ---------- 로그인 ----------
class LoginIn(BaseModel):
    password: str


class WaitIn(BaseModel):
    wait: str


class RecoveryIn(BaseModel):
    password: str
    code: str


@app.get("/api/status")
def status(req: Request):
    return {
        "server": True,
        "loggedIn": auth.logged_in(req),
        "loginReady": config.login_configured(),
        "telegram": telegram.configured() and config.TELEGRAM_LOGIN_APPROVAL,  # 로그인 화면의 승인 안내용
        "recovery": auth.recovery_left() > 0,
        "kis": {
            "configured": config.kis_configured(),
            "mode": config.KIS_MODE,
            "lastOk": kis.last_ok or None,
            "lastError": kis.last_error or None,
            "telegramError": telegram.last_error or None,
            "realtime": {k: realtime.state[k] for k in ("kis", "upbit", "slots", "overflow", "lastTick")},
            "limits": {k: settings.get(k) for k in ("orderLimit", "allowMarket", "emergency")},
            "ai": ai.configured(),
        }
        if auth.logged_in(req)
        else None,
        "marketOpen": market.market_open(),
        "sessions": market.sessions(),
    }


@app.post("/api/login")
async def login(body: LoginIn, req: Request, res: Response):
    return await auth.login(req, res, body.password)


@app.post("/api/login/wait")
def login_wait(body: WaitIn, res: Response):
    return auth.wait(res, body.wait)


@app.post("/api/login/recovery")
async def login_recovery(body: RecoveryIn, req: Request, res: Response):
    return await auth.login_recovery(req, res, body.password, body.code)


@app.post("/api/logout")
def logout(res: Response):
    auth.logout(res)
    return {"ok": True}


# ---------- 조회 ----------
api = [Depends(auth.require_login)]


@app.get("/api/market", dependencies=api + [Depends(need_kis)])
def get_market():
    stocks = [market.quotes[c] for c, _, _ in UNIVERSE if c in market.quotes]
    order = ["kospi", "kosdaq", "kospi200", "nasdaq", "sp500", "dow", "nasdaq100", "sox"]
    idx = sorted(market.indices.values(), key=lambda i: order.index(i["id"]) if i["id"] in order else 99)
    if prices.fx.get("usd"):
        idx.append({"id": "usdkrw", "name": "원/달러", "value": prices.fx["usd"], "prev": prices.fx.get("prev") or prices.fx["usd"], "group": "fx", "at": prices.fx.get("at")})
    return {"indices": idx, "sessions": market.sessions(), "stocks": stocks, "total": len(UNIVERSE), "at": max([s["at"] for s in stocks], default=None)}


@app.get("/api/market/view", dependencies=api + [Depends(need_kis)])
@kis_errors
async def get_market_view(v: str = "kospi50"):
    return await views.get_view(v)


@app.get("/api/search", dependencies=api)
async def get_search(q: str = ""):  # async: 뒤에서 순위를 받으려면 이벤트 루프 안이어야 한다
    return {"hits": views.search(q[:30])}


@app.get("/api/us/{sym}", dependencies=api + [Depends(need_kis)])
@kis_errors
async def get_us(sym: str):
    if not views.is_us_symbol(sym.upper()):
        raise HTTPException(400, "티커는 영문입니다 (예: AAPL)")
    return await views.us_detail(sym)


@app.get("/api/us/{sym}/candles", dependencies=api + [Depends(need_kis)])
@kis_errors
async def get_us_candles(sym: str, period: str = "D"):
    if not views.is_us_symbol(sym.upper()) or period not in ("D", "W", "M"):
        raise HTTPException(400, "잘못된 요청입니다")
    return {"candles": await views.us_candles(sym, period)}


@app.get("/api/portfolio", dependencies=api + [Depends(need_kis)])
def get_portfolio(account: str = "all"):
    """모든 자산을 한 포트폴리오로: 한투(연동) + 수기 계좌. account = all | kis | 수기 계좌 id"""
    accounts = [{"id": "kis", "name": config.KIS_ACCOUNT_NAME, "linked": True}] + [{**a, "linked": False} for a in ledger.load()["accounts"]]
    if account not in {a["id"] for a in accounts} | {"all"}:
        raise HTTPException(400, "없는 계좌입니다")
    hs: dict[str, dict] = {}
    cash = 0.0
    at = time.time()
    if account in ("all", "kis"):
        if not market.balance:
            raise HTTPException(503, detail={"code": "LOADING", "msg": f"잔고를 아직 못 받았습니다 ({kis.last_error})" if kis.last_error else "잔고를 처음 받아 오는 중입니다"})
        for h in market.balance["holdings"]:
            q = market.quotes.get(h["code"], {})
            hs[h["code"]] = {**h, "asset": "kr", "price": q.get("price") or h["price"], "prev": q.get("prev") or h["price"], "accounts": [{"id": "kis", "name": config.KIS_ACCOUNT_NAME, "qty": h["qty"]}]}
        cash += market.balance["cash"]
        # 한투 해외(미국) 잔고: 원화로 바꿔 같은 모양으로 (시세는 자동 시세가 있으면 그것, 없으면 잔고 응답의 현재가)
        fx = prices.fx.get("usd") or ledger.usd(ledger.load())[0]
        for o in market.balance.get("overseas", []):
            live_p = (prices.overseas.get(o["symbol"]) or {})
            p_usd = live_p.get("price") or o["price"] or o["avg"]
            prev_usd = live_p.get("prev") or p_usd
            code = f"us:{o['symbol']}"
            hs[code] = {"code": code, "name": o["name"], "sector": "해외주식", "asset": "us", "qty": o["qty"], "avg": o["avg"] * fx, "price": p_usd * fx, "prev": prev_usd * fx, "sellable": o["sellable"], "currency": "USD", "rawPrice": p_usd, "manualPrice": False, "accounts": [{"id": "kis", "name": config.KIS_ACCOUNT_NAME, "qty": o["qty"]}]}
        cash += market.balance.get("usdCash", 0) * fx
        at = market.balance["at"]
    m = ledger.holdings("all" if account in ("all", "kis") else account, market.quotes) if account != "kis" else {"holdings": [], "cash": 0, "realized": 0, "dividends": 0, "fx": 0, "fxSource": "", "usesUsd": False, "fxDefault": False}
    for h in m["holdings"]:
        old = hs.get(h["code"])
        if old and old.get("currency") != h.get("currency") and h.get("asset") == "us":
            old = None  # 통화가 다르면 따로 (드묾)
        if old:  # 같은 종목이 한투와 수기 계좌에 다 있으면 한 줄로 (평균단가는 수량 가중)
            qty = old["qty"] + h["qty"]
            hs[h["code"]] = {**old, "qty": qty, "avg": (old["avg"] * old["qty"] + h["avg"] * h["qty"]) / qty, "accounts": old["accounts"] + h["accounts"]}
        else:
            hs[h["code"]] = h
    cash += m["cash"]
    return {"holdings": list(hs.values()), "cash": cash, "at": at, "accounts": accounts, "realized": m["realized"], "dividends": m["dividends"], "fx": m["fx"], "fxSource": m["fxSource"], "usesUsd": m["usesUsd"], "fxDefault": m["fxDefault"]}


# ---------- 수기 자산 ----------
class NameIn(BaseModel):
    name: str


class ValueIn(BaseModel):
    value: float


class PriceIn(BaseModel):
    key: str
    price: float


def _rec_text(r: dict) -> str:
    k = {"buy": "매수", "sell": "매도", "div": "배당·이자", "value": "금액 평가"}.get(r["kind"], r["kind"])
    if r["kind"] in ("buy", "sell"):
        return f"{r['date']} {k} {r['name']} {r['qty']:g} × {r['price']:,.2f} {r['currency']}"
    return f"{r['date']} {k} {r['name']} {r['amount']:,.0f} {r['currency']}"


async def _find_name(code: str) -> str:
    from .universe import NAMES

    if code in NAMES:
        return NAMES[code]
    q = market.quotes.get(code)
    if q:
        return q["name"]
    if not config.kis_configured():
        raise HTTPException(400, "종목 이름을 같이 넣어 주세요")
    try:
        return (await market.fetch_quote(code))["name"]
    except KISError:
        raise HTTPException(400, f"종목코드 {code} 를 찾지 못했습니다") from None


@app.get("/api/ledger", dependencies=api)
def get_ledger():
    return ledger.view()


@app.post("/api/ledger/accounts", dependencies=api)
async def post_account(b: NameIn):
    a = await ledger.add_account(b.name)
    activity.log("ledger", f"수기 계좌 만듦: {a['name']}")
    return a


@app.put("/api/ledger/accounts/{aid}", dependencies=api)
async def put_account(aid: str, b: NameIn):
    a = await ledger.rename_account(aid, b.name)
    activity.log("ledger", f"수기 계좌 이름 바꿈: {a['name']}")
    return a


@app.delete("/api/ledger/accounts/{aid}", dependencies=api)
async def del_account(aid: str):
    await ledger.delete_account(aid)
    activity.log("ledger", f"수기 계좌 지움: {aid}")
    return {"ok": True}


@app.post("/api/ledger/records", dependencies=api)
async def post_record(b: ledger.RecordIn):
    r = await ledger.add_record(b, _find_name)
    activity.log("ledger", f"수기 기록 추가: {_rec_text(r)}")
    prices.wake.set()  # 새 해외주식·코인이면 시세를 바로 받는다
    return r


@app.put("/api/ledger/records/{rid}", dependencies=api)
async def put_record(rid: str, b: ledger.RecordIn):
    r = await ledger.edit_record(rid, b, _find_name)
    activity.log("ledger", f"수기 기록 고침: {_rec_text(r)}")
    return r


@app.delete("/api/ledger/records/{rid}", dependencies=api)
async def del_record(rid: str):
    await ledger.delete_record(rid)
    activity.log("ledger", f"수기 기록 지움: {rid}")
    return {"ok": True}


@app.put("/api/ledger/fx", dependencies=api)
async def put_fx(b: ValueIn):
    await ledger.set_fx(b.value)
    activity.log("ledger", f"환율 직접 입력: 1달러 {b.value:,.2f}원")
    return {"ok": True}


@app.put("/api/ledger/price", dependencies=api)
async def put_price(b: PriceIn):
    await ledger.set_price(b.key, b.price)
    activity.log("ledger", f"현재가 직접 입력: {b.key} {b.price:,}")
    return {"ok": True}


@app.get("/api/stock/{code}", dependencies=api + [Depends(need_kis)])
@kis_errors
async def get_stock(code: str):
    if not config.is_kr_code(code):
        raise HTTPException(400, "종목코드는 6자리 숫자입니다")
    realtime.see(code)  # 보고 있는 종목은 실시간 자리 1순위
    q = await market.quote_fast(code)
    if q.get("name") in ("", code) and (n := views.kr_name(code)):
        q["name"] = n
    return q


@app.get("/api/stock/{code}/candles", dependencies=api + [Depends(need_kis)])
@kis_errors
async def get_candles(code: str, period: str = "D"):
    if not config.is_kr_code(code) or period not in ("D", "W", "M"):
        raise HTTPException(400, "잘못된 요청입니다")
    return {"candles": await market.fetch_candles(code, period)}


@app.get("/api/stock/{code}/book", dependencies=api + [Depends(need_kis)])
@kis_errors
async def get_book(code: str):
    if not config.is_kr_code(code):
        raise HTTPException(400, "종목코드는 6자리 숫자입니다")
    b = realtime.books.get(code)
    if b and time.time() - b["at"] < 3:
        return b
    return await market.fetch_book(code)


# ---------- 주문 (모의) ----------
@app.post("/api/orders", dependencies=api + [Depends(need_kis)])
async def post_order(o: orders.OrderIn):
    return await orders.place(o)


@app.get("/api/orders", dependencies=api + [Depends(need_kis)])
@kis_errors
async def get_orders(scope: str = "open", days: int = 30):
    if scope not in ("open", "today", "past") or not 1 <= days <= 90:
        raise HTTPException(400, "잘못된 요청입니다")
    return await orders.list_orders(scope, days)


@app.post("/api/orders/cancel-all", dependencies=api + [Depends(need_kis)])
@kis_errors
async def post_cancel_all():
    return await orders.cancel_all()


@app.post("/api/orders/{no}/cancel", dependencies=api + [Depends(need_kis)])
@kis_errors
async def post_cancel(no: str):
    if not no.isdigit():
        raise HTTPException(400, "주문번호가 잘못됐습니다")
    return await orders.cancel(no)


@app.post("/api/orders/{no}/modify", dependencies=api + [Depends(need_kis)])
@kis_errors
async def post_modify(no: str, m: orders.ModifyIn):
    if not no.isdigit():
        raise HTTPException(400, "주문번호가 잘못됐습니다")
    return await orders.modify(no, m)


@app.get("/api/orders/today", dependencies=api)
def get_orders_today():
    return {"orders": orders.today_log()}


# ---------- 기록 · 설정 ----------
@app.get("/api/log", dependencies=api)
def get_log(days: int = 7):
    if not 1 <= days <= 365:
        raise HTTPException(400, "기간은 1~365일입니다")
    items = activity.merged(days)
    today = __import__("datetime").datetime.now(market.KST).strftime("%Y-%m-%d")
    t = [x for x in items if x["at"].startswith(today)]
    return {
        "items": items[:1000],
        "today": {
            "orders": len([x for x in t if x["type"] == "order" and x["result"] == "접수"]),
            "refused": len([x for x in t if x["type"] == "order" and x["result"] == "거절"]),
            "rules": len([x for x in t if x["type"] == "rule" and "발동" in x["text"]]),
            "logins": len([x for x in t if x["type"] == "login"]),
        },
    }


class EmergencyIn(BaseModel):
    on: bool
    password: str = ""


class PasswordIn(BaseModel):
    password: str


@app.get("/api/settings", dependencies=api)
def get_settings():
    return {
        **settings.public(),
        "mode": config.KIS_MODE,
        "kisConfigured": config.kis_configured(),
        "telegram": telegram.configured(),
        "rulesHalted": rules.load()["halted"],
        "realtime": {k: realtime.state[k] for k in ("kis", "upbit", "slots", "overflow")},
        "sessionHours": config.SESSION_HOURS,
    }


@app.put("/api/settings", dependencies=api)
def put_settings(b: settings.LimitsIn):
    changed = settings.set_limits(b)
    names = {"orderLimit": "1회 주문 금액", "dailyMaxOrders": "하루 주문 횟수", "dailyMaxAmount": "하루 주문 총액", "allowMarket": "시장가 허용"}
    if changed:
        activity.log("setting", "한도 바꿈: " + ", ".join(f"{names[k]} {a} → {b2}" for k, (a, b2) in changed.items()))
    return settings.public()


@app.post("/api/settings/emergency", dependencies=api)
async def post_emergency(b: EmergencyIn):
    settings.set_emergency(b.on, b.password)
    if b.on:
        await rules.halt(True)  # 규칙도 멈춘다 (풀 때 규칙은 규칙 화면에서 따로 다시 시작)
    activity.log("setting", "비상 정지 켬: 새 주문·정정 막음, 규칙 멈춤" if b.on else "비상 정지 풂", result="켬" if b.on else "풂")
    realtime._bump()
    return settings.public()


@app.post("/api/settings/logout-all", dependencies=api)
def post_logout_all(b: PasswordIn, res: Response):
    settings.check_password(b.password)
    settings.rotate_sessions()
    activity.log("setting", "모든 기기 로그아웃", result="완료")
    auth.logout(res)
    return {"ok": True}


# ---------- AI ----------
@app.post("/api/ai/chat", dependencies=api)
async def ai_chat(b: ai.ChatIn):
    if not ai.configured():
        raise HTTPException(503, "AI 키가 아직 없습니다 (backend/.env 의 ANTHROPIC_API_KEY)")
    try:
        port = get_portfolio("all") if config.kis_configured() else None
    except HTTPException:
        port = None
    rules_text = [r["text"] for r in rules.view()["rules"] if r["state"] == "watching"]
    gen = await ai.answer(b, ai.context(port, rules_text))
    q = "세 줄 리뷰" if b.review else b.messages[-1].content[:60]
    activity.log("ai", f"AI {ai.INVESTORS[b.investor].split(' (')[0]} 관점: {q}")
    return StreamingResponse(gen, media_type="text/plain; charset=utf-8", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


# ---------- 투자 하네스 (가상 계좌) ----------
class HarnessOn(BaseModel):
    on: bool


class HarnessRun(BaseModel):
    market: str


class HarnessNew(BaseModel):
    name: str = ""
    ants: list[str]


class HarnessTeam(BaseModel):
    team: list


class AntIn(BaseModel):
    name: str = ""
    role: str | None = None
    persona: str | None = None
    temper: str | None = None
    motto: str | None = None
    philosophy: str | None = None
    color: int | None = None


class AntStatus(BaseModel):
    status: str


class AntGen(BaseModel):
    hint: str = ""


@app.post("/api/harness", dependencies=api)
def new_harness(b: HarnessNew):
    try:
        a = harness.create(b.name, b.ants)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    activity.log("harness", f"가상 계좌 만듦: {a['name']}")
    return {"id": a["id"]}


@app.put("/api/harness/{aid}/team", dependencies=api)
def put_harness_team(aid: str, b: HarnessTeam):
    a = harness.account(aid)
    if not a:
        raise HTTPException(404, "없는 하네스 계좌입니다")
    try:
        harness.set_team(a, b.team)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    activity.log("harness", f"{a['name']} 팀 바꿈: " + ", ".join(m["name"] for m in harness.team_of(a)))
    return {"ok": True}


@app.get("/api/harness", dependencies=api)
async def get_harness():
    return await harness.view()


@app.post("/api/harness/{aid}/enabled", dependencies=api)
def set_harness(aid: str, b: HarnessOn):
    a = harness.account(aid)
    if not a:
        raise HTTPException(404, "없는 하네스 계좌입니다")
    a["enabled"] = b.on
    if b.on and a.get("halted"):
        # 정지선(-30%)에 걸린 계좌를 다시 켜면 지금 값을 새 기준으로 (안 그러면 바로 다시 멈춘다)
        a["start"] = round(a["cash"] + sum(p["qty"] * p["avgKrw"] for p in a["positions"].values()))
        a["halted"] = ""
    harness._save()
    activity.log("harness", f"{a['name']} {'켬' if b.on else '끔'}")
    return {"ok": True}


@app.post("/api/harness/{aid}/decide", dependencies=api + [Depends(need_kis)])
async def run_harness(aid: str, b: HarnessRun):
    a = harness.account(aid)
    if not a:
        raise HTTPException(404, "없는 하네스 계좌입니다")
    if b.market not in ("kr", "us") or not harness.session_open(b.market):
        raise HTTPException(400, "그 시장의 정규장 시간에만 지금 판단할 수 있습니다")
    if not ai.configured():
        raise HTTPException(400, "AI 가 연결돼 있지 않습니다")
    if harness.state["running"]:
        raise HTTPException(409, "이미 판단하는 중입니다")
    activity.log("harness", f"{a['name']} 지금 판단 ({b.market})")
    return await harness.decide(a, b.market, "직접 요청")


class HarnessLimits(BaseModel):
    limits: dict


class HarnessMove(BaseModel):
    src: str
    dst: str
    amount: float


# ---------- 개미 캐릭터 (2026-11-26) ----------
@app.post("/api/ants", dependencies=api)
def new_ant(b: AntIn):
    try:
        x = ants.create(b.model_dump(exclude_none=True))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    harness._save()
    activity.log("harness", f"개미 만듦: {x['name']}")
    return ants.view(x)


@app.put("/api/ants/{ant_id}", dependencies=api)
def put_ant(ant_id: str, b: AntIn):
    x = ants.get(ant_id)
    if not x:
        raise HTTPException(404, "없는 개미입니다")
    try:
        ants.update(x, {k: v for k, v in b.model_dump(exclude_none=True).items() if not (k == "name" and not v)})
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    for a in ants.teams_of(ant_id):
        a["debate"] = {}  # 캐릭터가 바뀌면 다음 판단에서 새로 토론
    harness._save()
    activity.log("harness", f"개미 고침: {x['name']}")
    return ants.view(x)


@app.post("/api/ants/{ant_id}/status", dependencies=api)
def ant_status(ant_id: str, b: AntStatus):
    x = ants.get(ant_id)
    if not x:
        raise HTTPException(404, "없는 개미입니다")
    try:
        ants.set_status(x, b.status)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    harness._save()
    activity.log("harness", f"개미 {'휴직' if b.status == 'rest' else '복귀'}: {x['name']}")
    return ants.view(x)


@app.post("/api/ants/generate", dependencies=api)
async def gen_ant(b: AntGen):
    if not ai.configured():
        raise HTTPException(400, "AI 가 연결돼 있지 않습니다")
    try:
        return await ants.generate(b.hint)
    except ValueError as e:
        raise HTTPException(400, f"AI 답을 읽지 못했습니다: {e}") from e


@app.get("/api/harness/summary", dependencies=api)
async def harness_summary():
    """내 자산 화면용 가상 계좌 요약"""
    return {"accounts": await harness.summary()}


@app.put("/api/harness/{aid}/limits", dependencies=api)
def put_harness_limits(aid: str, b: HarnessLimits):
    """사용자가 직접 한도 바꾸기 (AI 가 바꾸는 것과 같은 범위)"""
    a = harness.account(aid)
    if not a:
        raise HTTPException(404, "없는 하네스 계좌입니다")
    ch = harness.set_limits(a, b.limits, "사용자가 직접", "사용자")
    harness._save()
    if ch:
        activity.log("harness", f"{a['name']} 한도 바꿈: " + ", ".join(ch))
    return {"changes": ch}


@app.post("/api/harness/transfer", dependencies=api)
def harness_transfer(b: HarnessMove):
    s, d = harness.account(b.src), harness.account(b.dst)
    if not s or not d:
        raise HTTPException(404, "없는 하네스 계좌입니다")
    r = evolve.transfer(s, d, b.amount, "사용자", "사용자가 직접")
    harness._save()
    if r.startswith("거절"):
        raise HTTPException(400, r)
    activity.log("harness", r)
    return {"result": r}


@app.post("/api/harness/hq/run", dependencies=api + [Depends(need_kis)])
async def harness_hq_run():
    if not ai.configured():
        raise HTTPException(400, "AI 가 연결돼 있지 않습니다")
    if harness.state["running"]:
        raise HTTPException(409, "이미 판단하는 중입니다")
    activity.log("harness", "운용 본부 지금 실행")
    return await evolve.hq_run("직접 요청")


@app.post("/api/harness/{aid}/review", dependencies=api + [Depends(need_kis)])
async def harness_review(aid: str):
    a = harness.account(aid)
    if not a:
        raise HTTPException(404, "없는 하네스 계좌입니다")
    if harness.state["running"]:
        raise HTTPException(409, "이미 판단하는 중입니다")
    harness.state["running"] = f"{aid}:review"
    try:
        names = await evolve.review(a, "직접")
    finally:
        harness.state["running"] = ""
    activity.log("harness", f"{a['name']} 지금 복기")
    return {"reviewed": names}


# ---------- 자산 지킴이 ----------
@app.get("/api/guard", dependencies=api)
def get_guard():
    return guard.view()


@app.put("/api/guard", dependencies=api)
def put_guard(b: guard.AnswerIn):
    return guard.set_answer(b)


@app.post("/api/guard/ask", dependencies=api)
async def post_guard_ask():
    """아직 안 정한 기준을 텔레그램으로 지금 묻기"""
    return {"sent": await guard.ask_next(force=True)}


# ---------- 알림 ----------
@app.get("/api/alerts", dependencies=api)
def get_alerts(limit: int = 50):
    return alerts.view(max(1, min(limit, 300)))


@app.put("/api/alerts/settings", dependencies=api)
def put_alert_settings(b: alerts.SettingsIn):
    changed = alerts.save_settings(b)
    if changed:
        activity.log("setting", "알림 기준 바꿈: " + ", ".join(f"{k} {a}→{v}" for k, (a, v) in changed.items()))
    return alerts.view()


@app.post("/api/alerts/test", dependencies=api)
async def post_alert_test():
    return await alerts.test()


# ---------- 규칙 ----------
class StateIn(BaseModel):
    state: str


class HaltIn(BaseModel):
    on: bool


@app.get("/api/rules", dependencies=api)
def get_rules():
    return rules.view()


@app.post("/api/rules", dependencies=api + [Depends(need_kis)])
async def post_rule(b: rules.RuleIn):
    return await rules.add(b)


@app.put("/api/rules/{rid}", dependencies=api)
async def put_rule(rid: str, b: StateIn):
    return await rules.set_state(rid, b.state)


@app.delete("/api/rules/{rid}", dependencies=api)
async def del_rule(rid: str):
    await rules.delete(rid)
    return {"ok": True}


@app.post("/api/rules/halt", dependencies=api)
async def post_halt(b: HaltIn):
    await rules.halt(b.on)
    return {"ok": True}


@app.post("/api/rules/pending/{pid}/go", dependencies=api + [Depends(need_kis)])
async def post_pending_go(pid: str):
    return await rules.confirm(pid)


@app.post("/api/rules/pending/{pid}/dismiss", dependencies=api)
async def post_pending_dismiss(pid: str):
    await rules.dismiss(pid)
    return {"ok": True}


@app.get("/api/stream", dependencies=api)
async def stream(req: Request):
    """실시간 알림 (Server-Sent Events). 시세가 바뀌면 화면이 다시 받게 알린다. 초당 최대 4번으로 모은다"""

    async def gen():
        last = -1
        yield "retry: 3000\n\n"
        hb = time.time()
        while not await req.is_disconnected():
            v = realtime.version()
            if v != last:
                last = v
                hb = time.time()
                info = {"v": v, "at": realtime.state["lastTick"], "kis": realtime.state["kis"], "upbit": realtime.state["upbit"], "overflow": len(realtime.state["overflow"]), "rulesPending": len(rules.pending), "alert": alerts.recent[-1]["id"] if alerts.recent else ""}
                yield f"data: {json.dumps(info)}\n\n"
            elif time.time() - hb > 14:
                yield ": ping\n\n"  # 연결 유지
                hb = time.time()
            await asyncio.sleep(0.25)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
def api_404(rest: str):
    raise HTTPException(404, "없는 API 입니다")


# ---------- 화면 ----------
DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{rest:path}", include_in_schema=False)
    def spa(rest: str):
        f = (DIST / rest).resolve()
        if rest and f.is_file() and DIST in f.parents:
            return FileResponse(f)
        return FileResponse(DIST / "index.html")
