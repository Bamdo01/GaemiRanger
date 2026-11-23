"""자산 지킴이 (2026-11-24 사용자 목표: 트레이딩보다 내 자산 지키기).

사용자는 귀찮아서 미루는 성향이라 스스로 정해 주길 기다리지 않는다.
- 정해지지 않은 기준(목표 배분, 손실 한도, 손절 기준)은 텔레그램으로 하나씩 묻는다.
  질문마다 추천안과 최근 데이터 근거(계산한 숫자)를 붙이고, 버튼 하나로 답하게 한다.
- 답이 없으면 다시 묻는다: 보통 하루 뒤, 위험 신호(쏠림·큰 하락)가 크면 4시간 뒤. 횟수가 늘수록 더 강하게.
- 답하기 전에는 임시 기준(추천안)으로 지킨다.
- 텔레그램에 말을 걸면 Claude 가 내 자산·시세·뉴스를 근거로 답한다 (주문 도구 없음).
- 숫자는 모두 계산으로 낸다. AI 는 그 숫자를 보고 설득하는 말만 붙인다 (숫자를 지어내지 않게).
판다/안 판다는 언제나 사용자가 정한다. 이 모듈은 주문을 내지 않는다.
"""

import asyncio
import json
import os
import time
from collections import deque
from datetime import datetime

from fastapi import HTTPException
from pydantic import BaseModel

from . import config, market, telegram

FILE = config.DATA / "guard.json"

# 질문 순서 = 묻는 순서. 첫 값이 추천안이자 임시 기준
QUESTIONS: dict[str, dict] = {
    "target": {
        "title": "목표 자산 배분",
        "ask": "주식·금·현금을 어떤 비율로 둘지 정해 주세요. 이 비율에서 많이 벗어나면 무엇을 얼마 줄이고 늘릴지 알려 드립니다.",
        "options": [("70-10-20", "주식70 금10 현금20"), ("80-10-10", "주식80 금10 현금10"), ("60-15-25", "주식60 금15 현금25")],
    },
    "maxdd": {
        "title": "손실 한도",
        "ask": "전체 자산이 최고점보다 얼마나 떨어지면 강하게 알리고 점검을 요구할까요?",
        "options": [("10", "최고점 대비 -10%"), ("15", "-15%"), ("20", "-20%")],
    },
    "stop": {
        "title": "종목 손절 기준",
        "ask": "개별 종목(ETF·금 제외)이 어디까지 떨어지면 '팔지 정하세요' 알림을 보낼까요?",
        "options": [("trail15", "최고가 대비 -15%"), ("avg10", "산 값 대비 -10%"), ("both", "둘 중 먼저 닿는 쪽")],
    },
}
LIMIT_ONE = 15.0  # 한 종목 최대 비중 %
LIMIT_SECTOR = 30.0  # 한 업종 최대 비중 %
NAG_NORMAL = 24 * 3600
NAG_RISK = 4 * 3600

_hist: deque[dict] = deque(maxlen=12)  # 텔레그램 대화 (최근 몇 개만)
_busy = asyncio.Lock()


# ---------- 저장 ----------
def load() -> dict:
    try:
        d = json.loads(FILE.read_text("utf-8"))
    except (OSError, ValueError):
        d = {}
    d.setdefault("answers", {})
    d.setdefault("asked", {})
    d.setdefault("peak", {"value": 0, "at": ""})
    return d


def _save(d: dict) -> None:
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, FILE)


def criteria(d: dict | None = None) -> dict:
    """지금 쓰는 기준 (답이 없으면 추천안 = 임시)"""
    d = d or load()
    out = {}
    for k, q in QUESTIONS.items():
        v = d["answers"].get(k)
        out[k] = {"value": v or q["options"][0][0], "label": dict(q["options"]).get(v or q["options"][0][0], v), "temp": not v, "title": q["title"]}
    return out


def target_of(c: dict) -> dict:
    s, g, m = (int(x) for x in c["target"]["value"].split("-"))
    return {"주식": s, "금": g, "현금": m}


def _now() -> datetime:
    return datetime.now(market.KST)


# ---------- 숫자 (계산) ----------
def _portfolio() -> dict | None:
    from . import alerts

    return alerts._portfolio()


BUCKET = {"kr": "주식", "us": "주식", "coin": "주식", "gold": "금", "etc": "현금"}
ETF_BRANDS = ("KODEX", "TIGER", "ACE", "SOL ", "RISE", "KBSTAR", "HANARO", "PLUS", "KOSEF", "ARIRANG", "TIMEFOLIO", "KIWOOM", "1Q", "BNK", "WON ", "ETF", "Invesco", "SPDR", "iShares", "Vanguard", "Defiance", "ProShares", "Direxion")


def is_etf(name: str) -> bool:
    """ETF·지수 상품은 손절 대신 비중으로 관리 (이름으로 구분: 시세 응답만으로는 확실히 못 가림)"""
    n = name + " "
    return any(b in n for b in ETF_BRANDS)


def facts(port: dict) -> dict:
    """배분·쏠림·손절 후보를 계산. 금액은 원"""
    hs = port["holdings"]
    total = sum(h["qty"] * h["price"] for h in hs) + port["cash"]
    alloc = {"주식": 0.0, "금": 0.0, "현금": float(port["cash"])}
    sectors: dict[str, float] = {}
    rows = []
    for h in hs:
        amt = h["qty"] * h["price"]
        alloc[BUCKET.get(h.get("asset", "kr"), "주식")] += amt
        q = market.quotes.get(h["code"], {}) if h.get("asset") == "kr" else {}
        etf = is_etf(h.get("name", ""))
        sec = h.get("sector") or "기타"
        if h.get("asset") in ("kr", "us") and not etf and sec not in ("기타", "해외주식"):
            sectors[sec] = sectors.get(sec, 0) + amt  # 업종 쏠림은 업종을 아는 개별 종목만
        rows.append({
            "code": h["code"], "name": h.get("name", h["code"]), "asset": h.get("asset", "kr"), "amt": amt,
            "pct": amt / total * 100 if total else 0,
            "profit": (h["price"] - h["avg"]) / h["avg"] * 100 if h.get("avg") else 0,
            "today": (h["price"] - h["prev"]) / h["prev"] * 100 if h.get("prev") else 0,
            "fromHigh": (h["price"] - q["w52h"]) / q["w52h"] * 100 if q.get("w52h") else None,
            "single": h.get("asset") in ("kr", "us") and not etf,  # 손절 대상 (ETF·금·코인 제외)
            "price": h["price"], "avg": h.get("avg", 0), "high": q.get("w52h"),
        })
    rows.sort(key=lambda r: -r["amt"])
    pct = {k: v / total * 100 if total else 0 for k, v in alloc.items()}
    top_sector = max(sectors.items(), key=lambda x: x[1]) if sectors else ("", 0)
    today_won = sum(h["qty"] * (h["price"] - (h.get("prev") or h["price"])) for h in hs)
    return {
        "total": total, "alloc": alloc, "pct": pct, "rows": rows,
        "top": rows[0] if rows else None,
        "topSector": (top_sector[0], top_sector[1] / total * 100 if total else 0),
        "todayWon": today_won, "todayPct": today_won / (total - today_won) * 100 if total - today_won else 0,
    }


def risks(f: dict, c: dict) -> list[str]:
    """지금 걸리는 위험 (한 줄씩). 비면 안전"""
    out = []
    for r in f["rows"]:
        if r["pct"] > LIMIT_ONE and r["single"]:
            out.append(f"{r['name']} 한 종목이 자산의 {r['pct']:.0f}% (기준 {LIMIT_ONE:.0f}%)")
    if f["topSector"][1] > LIMIT_SECTOR:
        out.append(f"{f['topSector'][0]} 업종이 {f['topSector'][1]:.0f}% (기준 {LIMIT_SECTOR:.0f}%)")
    tgt = target_of(c)
    for k, v in tgt.items():
        if abs(f["pct"][k] - v) >= 5:
            out.append(f"{k} {f['pct'][k]:.0f}% (목표 {v}%, {f['pct'][k] - v:+.0f}%p)")
    for r in stop_hits(f, c):
        out.append(r)
    d = load()
    peak = d["peak"]["value"]
    if peak and f["total"] < peak:
        dd = (f["total"] - peak) / peak * 100
        if dd <= -float(c["maxdd"]["value"]):
            out.append(f"전체 자산이 최고점보다 {dd:.1f}% (한도 -{c['maxdd']['value']}%)")
    return out


def stop_hits(f: dict, c: dict) -> list[str]:
    rule = c["stop"]["value"]
    out = []
    for r in f["rows"]:
        if not r["single"]:
            continue
        why = []
        if rule in ("trail15", "both") and r["fromHigh"] is not None and r["fromHigh"] <= -15:
            why.append(f"52주 최고가 대비 {r['fromHigh']:.0f}%")
        if rule in ("avg10", "both") and r["profit"] <= -10:
            why.append(f"산 값 대비 {r['profit']:.0f}%")
        if why:
            out.append(f"{r['name']} 손절선 닿음 ({', '.join(why)})")
    return out


async def _top_drawdown(code: str) -> str:
    """보유 1위 국내 종목의 최근 3달 최고가 대비 최대 하락 (최근 정보 근거)"""
    try:
        cs = (await market.fetch_candles(code, "D"))[-65:]
    except Exception:  # noqa: BLE001
        return ""
    if len(cs) < 20:
        return ""
    peak, worst = 0, 0.0
    for x in cs:
        peak = max(peak, x["h"])
        if peak:
            worst = min(worst, (x["l"] - peak) / peak * 100)
    return f"최근 3달 사이 최고가 대비 최대 {worst:.0f}%까지 떨어진 적이 있습니다"


def _won(v: float) -> str:
    return f"{round(v):,}원"


async def evidence(key: str, f: dict, c: dict) -> list[str]:
    from . import alerts

    top = f["top"]
    lines = []
    if key == "target":
        p = f["pct"]
        lines.append(f"지금 배분: 주식 {p['주식']:.0f}% · 금 {p['금']:.0f}% · 현금 {p['현금']:.0f}%")
        if top:
            lines.append(f"가장 큰 종목: {top['name']} {top['pct']:.0f}%")
        if f["topSector"][0]:
            lines.append(f"가장 큰 업종: {f['topSector'][0]} {f['topSector'][1]:.0f}%")
        if p["현금"] < 10:
            lines.append("현금이 10%도 안 됩니다. 떨어졌을 때 살 돈도, 버틸 여유도 없습니다")
    elif key == "maxdd":
        for pct in (10, 15, 20):
            lines.append(f"-{pct}% = {_won(f['total'] * pct / 100)} 손실 (총자산 {_won(f['total'])} 기준)")
        lines.append(f"오늘 내 자산 {f['todayPct']:+.2f}% ({f['todayWon']:+,.0f}원)")
    elif key == "stop":
        singles = [r for r in f["rows"] if r["single"]]
        lines.append(f"손절 대상 개별 종목 {len(singles)}개 (ETF·금·코인 제외)")
        for r in singles[:4]:
            fh = f", 52주 최고가 대비 {r['fromHigh']:.0f}%" if r["fromHigh"] is not None else ""
            lines.append(f"{r['name']}: 산 값 대비 {r['profit']:+.0f}%{fh}")
    if top and top["asset"] == "kr" and key in ("target", "maxdd"):
        dd = await _top_drawdown(top["code"])
        if dd:
            lines.append(f"{top['name']}은(는) {dd}")
    n = len(alerts.for_ai(24, 50))
    if n:
        lines.append(f"최근 24시간 알림 {n}건")
    return lines


# ---------- 묻기 ----------
def _pending(d: dict) -> str | None:
    return next((k for k in QUESTIONS if not d["answers"].get(k)), None)


def _buttons(key: str) -> list[list[tuple[str, str]]]:
    q = QUESTIONS[key]
    rows = [[((("추천 · " if i == 0 else "") + label), f"g:{key}:{v}")] for i, (v, label) in enumerate(q["options"])]
    rows.append([("내일 다시 물어봐", f"g:later:{key}")])
    return rows


def _ask_text(key: str, n: int, ev: list[str], risk: list[str], persuade: str = "") -> str:
    q = QUESTIONS[key]
    head = ["[개미레인저 지킴이] " + q["title"]]
    if n >= 3 or (n >= 2 and risk):
        head.append("[중요] 아직 기준이 없습니다. 기준이 없으면 떨어질 때 또 '아니겠지' 하며 미루게 됩니다. 지금 정해 주세요.")
    elif n == 2:
        head.append("어제 물었던 것을 다시 묻습니다. 버튼 하나면 끝납니다.")
    lines = head + ["", q["ask"], "", "근거 (지금 내 자산, 최근 데이터):"] + [f"- {x}" for x in ev]
    if risk:
        lines += ["", "지금 걸리는 위험:"] + [f"- {x}" for x in risk[:5]]
    if persuade:
        lines += ["", "AI 한마디 (참고용)", persuade.strip()]
    lines += ["", f"정하기 전에는 추천안({q['options'][0][1]})을 임시 기준으로 씁니다."]
    return "\n".join(lines)[:3900]


async def ask_next(force: bool = False) -> bool:
    """정해지지 않은 질문 하나를 보낸다. 보냈으면 True"""
    if not telegram.configured():
        return False
    d = load()
    key = _pending(d)
    if not key:
        return False
    port = _portfolio()
    if not port:
        return False
    c = criteria(d)
    f = facts(port)
    rk = risks(f, c)
    a = d["asked"].get(key, {"n": 0, "at": 0, "snooze": 0})
    if not force:
        wait = NAG_RISK if rk else NAG_NORMAL
        h = _now().hour
        if not 9 <= h < 22:
            return False  # 밤에는 묻지 않는다
        if a.get("snooze", 0) > time.time() or (a["at"] and time.time() - a["at"] < wait):
            return False
    a["n"] = a.get("n", 0) + 1
    ev = await evidence(key, f, c)
    mid = await telegram.send(_ask_text(key, a["n"], ev, rk), _buttons(key))
    a.update(at=time.time(), mid=mid, snooze=0)
    d["asked"][key] = a
    _save(d)
    asyncio.create_task(_persuade(key, a["n"], ev, rk, mid))
    return True


async def _persuade(key: str, n: int, ev: list[str], rk: list[str], mid: int) -> None:
    """AI 가 근거 숫자만 보고 2~3문장으로 설득. 실패해도 질문은 이미 갔다"""
    from . import ai

    if not ai.configured():
        return
    q = QUESTIONS[key]
    prompt = (
        f"사용자는 귀찮아서 결정을 미루는 편이다. '{q['title']}'을(를) 지금 정하도록 2~3문장으로 설득해라. "
        "아래 근거 숫자만 쓰고 새 숫자를 지어내지 마라. 겁주지 말고 차분하게, 왜 지금 정하는 게 자산을 지키는지 말해라. 사라·팔라는 말은 하지 마라.\n\n"
        f"[질문] {q['ask']}\n[선택지] " + ", ".join(l for _, l in q["options"]) + "\n[근거]\n" + "\n".join(ev) + ("\n[지금 걸리는 위험]\n" + "\n".join(rk) if rk else "")
    )
    try:
        text = await ai.ask_once(prompt, "")
    except Exception:  # noqa: BLE001
        return
    if text.strip() and load()["answers"].get(key) is None:
        await telegram.edit(mid, _ask_text(key, n, ev, rk, text), _buttons(key))


def on_button(data: str) -> str:
    """텔레그램 버튼: g:<질문>:<값> 또는 g:later:<질문>"""
    _, a, b = (data.split(":", 2) + ["", ""])[:3]
    if a == "reset":
        return on_reset(b)
    d = load()
    if a == "later" and b in QUESTIONS:
        x = d["asked"].setdefault(b, {"n": 0, "at": 0})
        x["snooze"] = time.time() + 20 * 3600
        _save(d)
        return "내일 다시 묻겠습니다. 그때까지는 추천안으로 지킵니다"
    if a not in QUESTIONS or b not in dict(QUESTIONS[a]["options"]):
        return "처리할 수 없는 버튼입니다"
    d["answers"][a] = b
    _save(d)
    _log(f"지킴이 기준 정함: {QUESTIONS[a]['title']} = {dict(QUESTIONS[a]['options'])[b]}", "텔레그램")

    async def nxt():
        await asyncio.sleep(2)
        if not await ask_next(force=True):
            await telegram.send("기준을 모두 정했습니다. 앞으로 이 기준으로 지킵니다. /기준 으로 언제든 바꿀 수 있습니다.")

    asyncio.create_task(nxt())
    return f"{QUESTIONS[a]['title']}: {dict(QUESTIONS[a]['options'])[b]} 로 정했습니다"


def _log(text: str, by: str) -> None:
    from . import activity

    activity.log("setting", text, by=by)


# ---------- 앱에서 ----------
class AnswerIn(BaseModel):
    key: str
    value: str


def set_answer(b: AnswerIn) -> dict:
    if b.key not in QUESTIONS or b.value not in dict(QUESTIONS[b.key]["options"]):
        raise HTTPException(400, "없는 기준입니다")
    d = load()
    d["answers"][b.key] = b.value
    _save(d)
    _log(f"지킴이 기준 정함: {QUESTIONS[b.key]['title']} = {dict(QUESTIONS[b.key]['options'])[b.value]}", "화면")
    return view()


def view() -> dict:
    d = load()
    c = criteria(d)
    port = _portfolio()
    f = facts(port) if port else None
    return {
        "criteria": c,
        "questions": {k: {"title": q["title"], "ask": q["ask"], "options": q["options"]} for k, q in QUESTIONS.items()},
        "risks": risks(f, c) if f else [],
        "alloc": f["pct"] if f else None,
        "target": target_of(c),
        "peak": d["peak"],
        "total": f["total"] if f else None,
        "rebalance": rebalance(f, c) if f else [],
    }


def rebalance(f: dict, c: dict) -> list[str]:
    """목표에서 5%p 이상 벗어난 것만, 금액으로"""
    out = []
    for k, v in target_of(c).items():
        diff = f["alloc"][k] - f["total"] * v / 100
        if abs(diff) / f["total"] * 100 >= 5 if f["total"] else False:
            out.append(f"{k} {_won(abs(diff))} {'줄이기' if diff > 0 else '늘리기'} (지금 {f['pct'][k]:.0f}% → 목표 {v}%)")
    return out


# ---------- 텔레그램 말·명령 ----------
HELP = (
    "[개미레인저 지킴이]\n"
    "/점검 - 내 자산 점검 (배분, 쏠림, 손절선, 리밸런싱)\n"
    "/종목 삼성전자 - 한 종목 점검\n"
    "/기준 - 지금 기준 보기·다시 정하기\n"
    "그냥 말을 걸면 내 자산과 최근 시세·뉴스를 근거로 답합니다 (주문은 하지 않음)."
)


async def on_text(text: str) -> None:
    t = (text or "").strip()
    if not t:
        return
    try:
        if t in ("/start", "/help", "/도움", "도움"):
            await telegram.send(HELP)
            if _pending(load()):
                await ask_next(force=True)
        elif t.startswith("/점검") or t == "점검":
            await cmd_check()
        elif t.startswith("/종목"):
            await cmd_stock(t[3:].strip())
        elif t.startswith("/기준") or t == "기준":
            await cmd_criteria()
        else:
            await chat(t)
    except Exception as e:  # noqa: BLE001 - 봇이 죽지 않게
        await telegram.notify(f"처리 중 오류가 났습니다: {e.__class__.__name__}")


async def cmd_check() -> None:
    port = _portfolio()
    if not port:
        await telegram.send("아직 자산을 불러오지 못했습니다. 잠시 뒤 다시 해 주세요.")
        return
    c = criteria()
    f = facts(port)
    rk = risks(f, c)
    p = f["pct"]
    tgt = target_of(c)
    lines = [
        f"[점검] {_now():%m-%d %H:%M}",
        f"총자산 {_won(f['total'])} · 오늘 {f['todayPct']:+.2f}% ({f['todayWon']:+,.0f}원)",
        "",
        "배분 (지금 → 목표" + (", 임시" if c["target"]["temp"] else "") + ")",
        *[f"- {k} {p[k]:.0f}% → {tgt[k]}%" for k in tgt],
        "",
        "보유 상위",
        *[f"- {r['name']} {r['pct']:.0f}% · 수익 {r['profit']:+.0f}% · 오늘 {r['today']:+.1f}%" for r in f["rows"][:5]],
        "",
        "지금 걸리는 위험" if rk else "지금 걸리는 위험: 없음",
        *[f"- {x}" for x in rk],
    ]
    rb = rebalance(f, c)
    if rb:
        lines += ["", "리밸런싱 (목표 기준 계산)", *[f"- {x}" for x in rb]]
    temp = [v["title"] for v in c.values() if v["temp"]]
    if temp:
        lines += ["", "아직 안 정한 기준: " + ", ".join(temp) + " (지금은 추천안으로 지킴)"]
    mid = await telegram.send("\n".join(lines)[:3900])
    asyncio.create_task(_ai_tail(mid, "\n".join(lines), "위 점검 결과를 보고 지금 가장 먼저 할 일 하나와 그 이유를 3문장 안에 말해라. 숫자는 점검 결과에 있는 것만 쓴다."))


async def cmd_stock(q: str) -> None:
    from . import alerts

    port = _portfolio()
    if not port or not q:
        await telegram.send("사용법: /종목 삼성전자")
        return
    f = facts(port)
    r = next((x for x in f["rows"] if q.lower() in x["name"].lower() or q.upper() == x["code"].split(":")[-1]), None)
    if not r:
        await telegram.send(f"'{q}' 은(는) 보유 종목에 없습니다.")
        return
    c = criteria()
    lines = [f"[종목] {r['name']}", f"평가 {_won(r['amt'])} (자산의 {r['pct']:.1f}%) · 수익 {r['profit']:+.1f}% · 오늘 {r['today']:+.2f}%"]
    if r["single"]:
        rule = c["stop"]["value"]
        if rule in ("trail15", "both") and r["high"]:
            lines.append(f"손절선(52주 최고가 {r['high']:,} 대비 -15%): {r['high'] * 0.85:,.0f}원 · 지금 {r['price']:,.0f}원")
        if rule in ("avg10", "both") and r["avg"]:
            lines.append(f"손절선(산 값 {r['avg']:,.0f} 대비 -10%): {r['avg'] * 0.9:,.0f}원")
    else:
        lines.append("ETF·금·코인은 손절 대신 비중으로 관리합니다")
    news = [x for x in list(alerts.recent)[::-1] if x.get("code") == r["code"] and x["kind"] != "test"][:4]
    if news:
        lines += ["", "최근 알림·뉴스", *[f"- {x['at'][5:16].replace('T', ' ')} {x['title'][:80]}" for x in news]]
    if r["pct"] > LIMIT_ONE and r["single"]:
        lines.append(f"\n한 종목 비중이 기준 {LIMIT_ONE:.0f}%를 넘습니다")
    mid = await telegram.send("\n".join(lines))
    asyncio.create_task(_ai_tail(mid, "\n".join(lines), "이 종목을 계속 갖고 갈지 판단할 때 지금 확인할 것 세 가지를 '- '로 시작하는 세 줄로 말해라. 사라·팔라는 말은 하지 말고, 숫자는 위에 있는 것만 쓴다."))


async def cmd_criteria() -> None:
    c = criteria()
    lines = ["[지금 기준]"] + [f"- {v['title']}: {v['label']}" + (" (임시, 아직 안 정함)" if v["temp"] else "") for v in c.values()]
    lines.append("\n바꾸려면 아래에서 고르세요.")
    await telegram.send("\n".join(lines), [[(f"{q['title']} 다시 정하기", f"g:reset:{k}")] for k, q in QUESTIONS.items()])
    if _pending(load()):
        await ask_next(force=True)  # 아직 안 정한 게 있으면 바로 묻는다 (밤이어도 사용자가 먼저 불렀으니)


def on_reset(key: str) -> str:
    if key not in QUESTIONS:
        return "없는 기준입니다"
    d = load()
    d["answers"].pop(key, None)
    d["asked"].pop(key, None)
    _save(d)
    asyncio.create_task(ask_next(force=True))
    return f"{QUESTIONS[key]['title']} 을(를) 다시 묻겠습니다"


async def _ai_tail(mid: int, body: str, instruction: str) -> None:
    from . import ai

    if not ai.configured():
        return
    try:
        text = await ai.ask_once(instruction + "\n\n" + body, await _ctx())
    except Exception:  # noqa: BLE001
        return
    if text.strip():
        await telegram.edit(mid, (body + "\n\nAI 한마디 (참고용)\n" + text.strip())[:3900])


async def _ctx() -> str:
    from . import alerts

    return await alerts._ctx()


async def chat(text: str) -> None:
    from . import ai

    if not ai.configured():
        await telegram.send("AI 가 연결되어 있지 않습니다. " + HELP)
        return
    if _busy.locked():
        await telegram.send("앞 질문에 답하는 중입니다. 잠시만요.")
        return
    async with _busy:
        mid = await telegram.send("생각 중…")
        _hist.append({"role": "user", "content": text[:1500]})
        past = "\n".join(("사용자: " if m["role"] == "user" else "AI: ") + m["content"] for m in list(_hist)[:-1])
        c = criteria()
        crit = "; ".join(f"{v['title']} {v['label']}" + ("(임시)" if v["temp"] else "") for v in c.values())
        prompt = (
            "텔레그램 대화다. 7줄 이내로 짧게 답해라. 사용자의 목표는 '내 자산 지키기'이고, 귀찮아서 결정을 미루는 편이다. "
            "필요하면 근거를 들어 행동하도록 설득하되, 사라·팔라는 지시는 하지 말고 기준과 확인할 것을 말해라.\n"
            f"[지킴이 기준] {crit}\n" + (f"[지금까지 대화]\n{past}\n" if past else "") + f"[질문] {text}"
        )
        try:
            ans = (await ai.ask_once(prompt, await _ctx())).strip() or "(답이 비었습니다)"
        except HTTPException as e:
            ans = str(e.detail)
        _hist.append({"role": "assistant", "content": ans[:1500]})
        await telegram.edit(mid, ans[:3900])


# ---------- 매분 ----------
def _track_peak() -> None:
    port = _portfolio()
    if not port:
        return
    total = facts(port)["total"]
    d = load()
    if total > d["peak"].get("value", 0):
        d["peak"] = {"value": round(total), "at": _now().isoformat(timespec="minutes")}
        _save(d)


async def run_forever() -> None:
    await asyncio.sleep(60)  # 잔고·시세가 들어올 시간
    while True:
        try:
            _track_peak()
            await ask_next()
        except Exception as e:  # noqa: BLE001
            telegram.last_error = f"{telegram.now_text()} 지킴이 {e.__class__.__name__}: {e}"
        await asyncio.sleep(60)
