"""활동 기록 (L1): 로그인, 수기 기록 바꾸기, 설정 바꾸기를 data/activity.jsonl 에 남긴다.
주문은 orders.jsonl, 규칙 발동은 rule_events.jsonl 에 이미 남으니 /api/log 가 셋을 합쳐 보여 준다 (L2 포함).
"""

import json
from datetime import datetime, timedelta

from . import config, market

FILE = config.DATA / "activity.jsonl"


def log(kind: str, text: str, by: str = "화면", result: str = "", **extra) -> None:
    rec = {"at": datetime.now(market.KST).isoformat(timespec="seconds"), "kind": kind, "text": text, "by": by, "result": result, **extra}
    with FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def _read(path, since: str) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text("utf-8").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("at", "") >= since:
            out.append(r)
    return out


SIDE = {"buy": "매수", "sell": "매도"}


def merged(days: int) -> list[dict]:
    """주문·규칙·활동 기록을 하나로 (최근 것 먼저)"""
    from . import orders, rules

    since = (datetime.now(market.KST) - timedelta(days=days)).isoformat(timespec="seconds")
    out = []
    for r in _read(orders.LOG, since):
        if r.get("action") in ("취소", "정정"):
            text = f"{r['action']} 주문번호 {r.get('orderNo', '')}" + (f" → {r.get('price', 0):,}원 {r.get('qty', 0):,}주" if r["action"] == "정정" else "")
        else:
            kind = "시장가" if r.get("kind") == "market" else f"{r.get('price', 0):,}원"
            text = f"{r.get('code', '')} {SIDE.get(r.get('side'), '')} {r.get('qty', 0):,}주 {kind}"
        out.append({"at": r["at"], "type": "order", "text": text, "code": r.get("code", ""), "by": r.get("by", "화면"), "result": r.get("result", ""), "detail": r.get("reason") or r.get("msg") or (f"주문번호 {r['orderNo']}" if r.get("orderNo") else "")})
    for r in _read(rules.EVENTS, since):
        ev = r.get("event", "")
        res = "성공" if r.get("ok") else ("실패" if r.get("ok") is False else "")
        out.append({"at": r["at"], "type": "rule", "text": f"규칙 {r.get('rule', '')} {ev}" + (f" · {r['text']}" if r.get("text") else ""), "by": r.get("mode", "규칙"), "result": res or ev, "detail": r.get("msg", "") + (f" (발동 가격 {r['price']:,.0f}원)" if r.get("price") else "")})
    for r in _read(FILE, since):
        out.append({"at": r["at"], "type": r.get("kind", "etc"), "text": r.get("text", ""), "by": r.get("by", ""), "result": r.get("result", ""), "detail": r.get("detail", "")})
    out.sort(key=lambda x: x["at"], reverse=True)
    return out


def ip_of(req) -> str:
    return req.client.host if req and req.client else "?"

