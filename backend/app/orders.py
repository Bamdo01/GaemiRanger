"""모의 주문. 화면에서 검사했어도 서버가 다시 검사한다 (계획서: 한도와 안전장치는 서버가 강제).
모든 시도는 성공·실패와 함께 data/orders.jsonl 에 남는다 (기록 L1)."""

import json
import time
from datetime import datetime

from fastapi import HTTPException
from pydantic import BaseModel, Field

from . import config, market
from .kis import KISError, kis

ORDER = "/uapi/domestic-stock/v1/trading/order-cash"
LOG = config.DATA / "orders.jsonl"
DAILY_MAX_ORDERS = 30  # 하루 주문 횟수 상한 (설정 C1 전 임시값)


class OrderIn(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
    side: str = Field(pattern=r"^(buy|sell)$")
    kind: str = Field(pattern=r"^(limit|market)$")
    price: int = Field(ge=0, le=100_000_000)
    qty: int = Field(ge=1, le=1_000_000)


def tick(p: int) -> int:
    for lim, t in ((2000, 1), (5000, 5), (20000, 10), (50000, 50), (200000, 100), (500000, 500)):
        if p < lim:
            return t
    return 1000


def _log(rec: dict) -> None:
    with LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def today_log() -> list[dict]:
    if not LOG.exists():
        return []
    day = datetime.now(market.KST).strftime("%Y-%m-%d")
    out = []
    for line in LOG.read_text("utf-8").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("at", "").startswith(day):
            out.append(r)
    return out


async def place(o: OrderIn) -> dict:
    rec = {"at": datetime.now(market.KST).isoformat(timespec="seconds"), "mode": config.KIS_MODE, **o.model_dump(), "by": "화면"}

    def refuse(msg: str, status: int = 400):
        _log({**rec, "result": "거절", "reason": msg})
        raise HTTPException(status, msg)

    if config.KIS_MODE != "mock":
        refuse("지금은 모의투자만 주문할 수 있습니다", 403)
    if not market.market_open():
        refuse("장중(09:00~15:30)에만 주문할 수 있습니다")
    if len([r for r in today_log() if r.get("result") == "접수"]) >= DAILY_MAX_ORDERS:
        refuse(f"오늘 주문 {DAILY_MAX_ORDERS}회를 넘었습니다")

    # 최신 시세로 검사
    try:
        q = await market.fetch_quote(o.code)
    except KISError as e:
        refuse(f"시세를 확인하지 못해 주문하지 않았습니다: {e}", 502)
    price = q["price"] if o.kind == "market" else o.price
    if o.kind == "limit":
        if price % tick(price):
            refuse(f"호가 단위({tick(price):,}원)에 맞지 않습니다")
        if q["upper"] and not (q["lower"] <= price <= q["upper"]):
            refuse(f"상한가 {q['upper']:,} ~ 하한가 {q['lower']:,} 사이만 됩니다")
    amount = price * o.qty
    if amount > config.ORDER_LIMIT_WON:
        refuse(f"1회 주문 한도 {config.ORDER_LIMIT_WON:,}원을 넘습니다")
    try:
        if o.side == "buy":
            cash = await market.fetch_buyable(o.code, price, o.kind == "market")
            if amount > cash:
                refuse(f"주문가능금액 {cash:,}원이 모자랍니다")
        else:
            bal = await market.fetch_balance()
            have = next((h["sellable"] for h in bal["holdings"] if h["code"] == o.code), 0)
            if o.qty > have:
                refuse(f"매도가능수량은 {have:,}주입니다")
        d = await kis.post(
            ORDER,
            "VTTC0012U" if o.side == "buy" else "VTTC0011U",
            {
                "CANO": config.KIS_CANO,
                "ACNT_PRDT_CD": config.KIS_ACNT_PRDT_CD,
                "PDNO": o.code,
                "ORD_DVSN": "01" if o.kind == "market" else "00",
                "ORD_QTY": str(o.qty),
                "ORD_UNPR": "0" if o.kind == "market" else str(price),
            },
        )
    except KISError as e:
        refuse(f"한투가 주문을 받지 않았습니다: {e}", 502)
    out = d.get("output") or {}
    res = {**rec, "result": "접수", "orderNo": out.get("ODNO", ""), "orderTime": out.get("ORD_TMD", ""), "msg": d.get("msg1", "").strip(), "amount": amount}
    _log(res)
    # 잔고는 다음 갱신 때 바뀐다. 바로 한 번 더 받아 둔다
    try:
        await market.fetch_balance()
    except KISError:
        pass
    return res
