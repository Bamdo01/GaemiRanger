"""설정 (C1 한도, C3 비상 정지, C6 로그인). data/settings.json 에 둔다 (git 에 안 올라감).

- 한도를 바꾸거나 비상 정지를 풀 때는 비밀번호를 다시 받는다 (2026-11-23 기본값: 로그인이 털려도 한도를 못 올리게)
- 비상 정지는 비밀번호 없이 바로 켠다: 새 주문·정정을 모두 막고 규칙도 멈춘다
"""

import json
import os
import secrets

from fastapi import HTTPException
from pydantic import BaseModel

from . import config

FILE = config.DATA / "settings.json"
DEFAULTS = {
    "orderLimit": config.ORDER_LIMIT_WON,  # 1회 주문 금액
    "dailyMaxOrders": 30,  # 하루 주문 횟수 (접수된 것)
    "dailyMaxAmount": 10_000_000,  # 하루 주문 총액
    "allowMarket": True,  # 시장가 주문 허용 (규칙 매도는 시장가라 끄면 규칙 매도도 막힘)
    "emergency": False,  # 비상 정지
    "sessionNonce": "",  # 바꾸면 모든 로그인이 풀린다
}
LIMITS = {"orderLimit": (10_000, 100_000_000), "dailyMaxOrders": (1, 500), "dailyMaxAmount": (10_000, 1_000_000_000)}


def load() -> dict:
    try:
        d = json.loads(FILE.read_text("utf-8"))
    except (OSError, ValueError):
        d = {}
    return {**DEFAULTS, **{k: v for k, v in d.items() if k in DEFAULTS}}


def _save(d: dict) -> None:
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, FILE)


def get(key: str):
    return load()[key]


def public() -> dict:
    d = load()
    return {k: v for k, v in d.items() if k != "sessionNonce"}


class LimitsIn(BaseModel):
    password: str
    orderLimit: int
    dailyMaxOrders: int
    dailyMaxAmount: int
    allowMarket: bool


def check_password(pw: str) -> None:
    from .auth import check_password as chk

    if not chk(pw or "", config.APP_PASSWORD_HASH):
        raise HTTPException(403, "비밀번호가 맞지 않습니다")


def set_limits(b: LimitsIn) -> dict:
    check_password(b.password)
    d = load()
    new = {"orderLimit": b.orderLimit, "dailyMaxOrders": b.dailyMaxOrders, "dailyMaxAmount": b.dailyMaxAmount}
    for k, v in new.items():
        lo, hi = LIMITS[k]
        if not lo <= v <= hi:
            raise HTTPException(400, f"{k} 는 {lo:,}~{hi:,} 사이여야 합니다")
    if b.dailyMaxAmount < b.orderLimit:
        raise HTTPException(400, "하루 주문 총액은 1회 주문 금액보다 커야 합니다")
    changed = {k: (d[k], v) for k, v in {**new, "allowMarket": b.allowMarket}.items() if d[k] != v}
    d.update(new, allowMarket=b.allowMarket)
    _save(d)
    return changed


def set_emergency(on: bool, password: str = "") -> None:
    if not on:
        check_password(password)  # 푸는 것만 비밀번호
    d = load()
    d["emergency"] = on
    _save(d)


def rotate_sessions() -> None:
    d = load()
    d["sessionNonce"] = secrets.token_hex(8)
    _save(d)
