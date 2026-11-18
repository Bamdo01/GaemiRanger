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

from . import auth, config, market, orders
from .kis import KISError, kis
from .universe import UNIVERSE


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(market.poll_forever())
    yield
    task.cancel()
    await kis.close()


app = FastAPI(title="GaemiRanger", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


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


@app.get("/api/status")
def status(req: Request):
    return {
        "server": True,
        "loggedIn": auth.logged_in(req),
        "loginReady": config.login_configured(),
        "kis": {
            "configured": config.kis_configured(),
            "mode": config.KIS_MODE,
            "lastOk": kis.last_ok or None,
            "lastError": kis.last_error or None,
        }
        if auth.logged_in(req)
        else None,
        "marketOpen": market.market_open(),
    }


@app.post("/api/login")
def login(body: LoginIn, req: Request, res: Response):
    auth.login(req, res, body.password)
    return {"ok": True}


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
    q = market.quotes.get(code)
    if not q or time.time() - q["at"] > 5:
        q = await market.fetch_quote(code)
    return q


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
