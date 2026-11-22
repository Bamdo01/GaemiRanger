"""GaemiRanger 서버. 실행: .venv\\Scripts\\python -m uvicorn app.main:app --port 8000

- 모든 /api 는 로그인이 필요하다 (/api/status, /api/login 제외).
- 한투 키가 없으면 503(NOT_CONFIGURED)을 돌려주고, 화면은 예시 데이터를 쓴다.
- frontend/dist 가 있으면 화면도 같이 내보낸다 (같은 주소라 쿠키 로그인이 그대로 된다).
"""

import asyncio
import functools
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth, config, market, orders, telegram
from .kis import URGENT, KISError, kis
from .universe import UNIVERSE


@asynccontextmanager
async def lifespan(_: FastAPI):
    tasks = [asyncio.create_task(market.poll_forever()), asyncio.create_task(telegram.poll_forever())]
    yield
    for t in tasks:
        t.cancel()
    await kis.close()
    await telegram.close()


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
def get_portfolio():
    if not market.balance:
        raise HTTPException(503, detail={"code": "LOADING", "msg": f"잔고를 아직 못 받았습니다 ({kis.last_error})" if kis.last_error else "잔고를 처음 받아 오는 중입니다"})
    hs = []
    for h in market.balance["holdings"]:
        q = market.quotes.get(h["code"], {})
        hs.append({**h, "price": q.get("price") or h["price"], "prev": q.get("prev") or h["price"]})
    return {"holdings": hs, "cash": market.balance["cash"], "at": market.balance["at"]}


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
