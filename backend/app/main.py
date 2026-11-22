"""GaemiRanger 서버. 실행: .venv\\Scripts\\python -m uvicorn app.main:app --port 8000

- 모든 /api 는 로그인이 필요하다 (/api/status, /api/login 제외).
- 한투 키가 없으면 503(NOT_CONFIGURED)을 돌려주고, 화면은 예시 데이터를 쓴다.
- frontend/dist 가 있으면 화면도 같이 내보낸다 (같은 주소라 쿠키 로그인이 그대로 된다).
"""

import asyncio
import functools
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth, config, ledger, market, orders, prices, telegram
from .kis import URGENT, KISError, kis
from .universe import UNIVERSE


@asynccontextmanager
async def lifespan(_: FastAPI):
    tasks = [asyncio.create_task(market.poll_forever()), asyncio.create_task(telegram.poll_forever()), asyncio.create_task(prices.poll_forever())]
    yield
    for t in tasks:
        t.cancel()
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
        "telegram": telegram.configured(),
        "recovery": auth.recovery_left() > 0,
        "kis": {
            "configured": config.kis_configured(),
            "mode": config.KIS_MODE,
            "lastOk": kis.last_ok or None,
            "lastError": kis.last_error or None,
            "telegramError": telegram.last_error or None,
        }
        if auth.logged_in(req)
        else None,
        "marketOpen": market.market_open(),
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
    return {"indices": list(market.indices.values()), "stocks": stocks, "total": len(UNIVERSE), "at": max([s["at"] for s in stocks], default=None)}


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
        at = market.balance["at"]
    m = ledger.holdings("all" if account in ("all", "kis") else account, market.quotes) if account != "kis" else {"holdings": [], "cash": 0, "realized": 0, "dividends": 0, "fx": 0, "fxSource": "", "usesUsd": False, "fxDefault": False}
    for h in m["holdings"]:
        old = hs.get(h["code"])
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
    return await ledger.add_account(b.name)


@app.put("/api/ledger/accounts/{aid}", dependencies=api)
async def put_account(aid: str, b: NameIn):
    return await ledger.rename_account(aid, b.name)


@app.delete("/api/ledger/accounts/{aid}", dependencies=api)
async def del_account(aid: str):
    await ledger.delete_account(aid)
    return {"ok": True}


@app.post("/api/ledger/records", dependencies=api)
async def post_record(b: ledger.RecordIn):
    r = await ledger.add_record(b, _find_name)
    prices.wake.set()  # 새 해외주식·코인이면 시세를 바로 받는다
    return r


@app.put("/api/ledger/records/{rid}", dependencies=api)
async def put_record(rid: str, b: ledger.RecordIn):
    return await ledger.edit_record(rid, b, _find_name)


@app.delete("/api/ledger/records/{rid}", dependencies=api)
async def del_record(rid: str):
    await ledger.delete_record(rid)
    return {"ok": True}


@app.put("/api/ledger/fx", dependencies=api)
async def put_fx(b: ValueIn):
    await ledger.set_fx(b.value)
    return {"ok": True}


@app.put("/api/ledger/price", dependencies=api)
async def put_price(b: PriceIn):
    await ledger.set_price(b.key, b.price)
    return {"ok": True}


@app.get("/api/stock/{code}", dependencies=api + [Depends(need_kis)])
@kis_errors
async def get_stock(code: str):
    if not code.isdigit() or len(code) != 6:
        raise HTTPException(400, "종목코드는 6자리 숫자입니다")
    return await market.quote_fast(code)


@app.get("/api/stock/{code}/candles", dependencies=api + [Depends(need_kis)])
@kis_errors
async def get_candles(code: str, period: str = "D"):
    if not code.isdigit() or len(code) != 6 or period not in ("D", "W", "M"):
        raise HTTPException(400, "잘못된 요청입니다")
    return {"candles": await market.fetch_candles(code, period)}


@app.get("/api/stock/{code}/book", dependencies=api + [Depends(need_kis)])
@kis_errors
async def get_book(code: str):
    if not code.isdigit() or len(code) != 6:
        raise HTTPException(400, "종목코드는 6자리 숫자입니다")
    return await market.fetch_book(code)


# ---------- 주문 (모의) ----------
@app.post("/api/orders", dependencies=api + [Depends(need_kis)])
async def post_order(o: orders.OrderIn):
    return await orders.place(o)


@app.get("/api/orders/today", dependencies=api)
def get_orders_today():
    return {"orders": orders.today_log()}


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
