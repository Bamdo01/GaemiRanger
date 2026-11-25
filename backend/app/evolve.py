"""하네스가 스스로 나아지는 부분 (2026-11-25)

1) 복기: 장 마감 보고 뒤, 팀원(또는 단독 AI)이 낸 판단을 코드가 실제 가격으로 채점하고
   팀원마다 AI 가 자기 성적표를 보고 교훈을 고쳐 쓴다. 교훈은 다음 판단의 지시문에 들어간다.
2) 운용 본부: 매주 토요일 10:00 (한국 시간) 모든 가상 계좌의 성적을 보고
   - 계좌 사이 현금 옮기기 (잘하는 팀에 더)
   - 성적 나쁜 팀원의 투자관·성향 바꾸기
   - 2주 넘은 꼴찌 계좌 해체 + 잘하는 팀을 바꾼 새 팀 만들기
   - 실제 계좌는 조언만 (돈을 움직이지 않는다)
   를 AI 가 정하고 코드가 그대로 적용한다. 진짜 계좌 주문은 하지 않는다.
"""

import time
from datetime import datetime, timedelta

from . import ai, harness, market, settings, telegram

MIN_SCORED = 5  # 채점된 판단이 이만큼 쌓여야 교훈을 쓴다 (우연을 실력으로 믿지 않게)
SCORE_AFTER_H = 18  # 이 시간이 지난 판단부터 채점
FINAL_AFTER_D = 7  # 이 날수가 지나면 점수를 굳힌다
RETIRE_AFTER_D = 14  # 이보다 어린 계좌는 해체하지 않는다
MAX_LESSONS = 6


def _ts(iso: str) -> float:
    return datetime.fromisoformat(iso).timestamp()


# ---------- 채점 ----------
def edge(c: dict) -> float:
    """판단 방향으로 본 수익률 (%): 사자 → 오른 만큼, 팔자·반대 → 내린 만큼"""
    r = c.get("ret")
    if r is None:
        return 0.0
    if c["kind"] == "buy":
        return r
    if c["kind"] in ("sell", "block"):
        return -r
    if c["kind"] == "stance":
        s = c.get("stance") or ""
        return r if "늘" in s else -r if "줄" in s else (1.5 - abs(r))
    return 0.0


def hit(c: dict) -> bool:
    return edge(c) > 0


async def score(a: dict, limit: int = 60) -> int:
    """채점 안 끝난 판단의 지금 수익률을 적는다. 받은 시세 수를 돌려준다"""
    now = time.time()
    cache: dict[tuple, float] = {}
    n = 0
    for c in a.get("calls") or []:
        if c.get("final"):
            continue
        age = now - _ts(c["at"])
        if age < SCORE_AFTER_H * 3600 or not c.get("price"):
            continue
        key = (c["mkt"], c["kind"] == "stance", c["code"])
        if key not in cache:
            if c["kind"] == "stance":
                cache[key] = float((market.indices.get(c["code"]) or {}).get("value") or 0)
            else:
                if n >= limit:
                    continue
                try:
                    cache[key], _ = await harness.price_of(c["mkt"], c["code"])
                except Exception:  # noqa: BLE001
                    cache[key] = 0.0
                n += 1
        cur = cache[key]
        if cur > 0:
            c["ret"] = round((cur / c["price"] - 1) * 100, 2)
            if age >= FINAL_AFTER_D * 86400:
                c["final"] = True
    return n


def stats(a: dict, who: str, sig: str) -> dict:
    cs = [c for c in a.get("calls") or [] if c["who"] == who and c.get("sig") == sig and c.get("ret") is not None]
    if not cs:
        return {"n": 0, "hit": 0, "avg": 0, "best": None, "worst": None}
    e = [edge(c) for c in cs]
    best = max(cs, key=edge)
    worst = min(cs, key=edge)
    return {
        "n": len(cs),
        "hit": sum(1 for c in cs if hit(c)) / len(cs) * 100,
        "avg": sum(e) / len(e),
        "best": {"code": best["code"], "name": best.get("name"), "kind": best["kind"], "edge": round(edge(best), 2)},
        "worst": {"code": worst["code"], "name": worst.get("name"), "kind": worst["kind"], "edge": round(edge(worst), 2)},
    }


KIND = {"buy": "사자", "sell": "팔자", "block": "매수 반대", "stance": "비중"}


def _call_line(c: dict) -> str:
    what = f"{KIND[c['kind']]} {c.get('stance') or ''}".strip()
    return f"- {c['at'][5:16]} {c['mkt']} {what} {c['code']} {c.get('name') or ''}: 그 뒤 {c['ret']:+.2f}% → {'맞음' if hit(c) else '틀림'}"


# ---------- 복기 ----------
REVIEW = """너는 가상 투자 팀의 한 사람으로서 자기 판단을 복기한다. 아래 성적표는 코드가 실제 가격으로 채점한 사실이다.
- 맞힌 판단과 틀린 판단에서 되풀이되는 패턴을 찾아, 다음 판단 때 지킬 교훈을 최대 6개로 고쳐 쓴다.
- 교훈은 구체적으로 (어떤 상황에서 무엇을 하고 무엇을 피할지). 일반론(분산하라 등)은 쓰지 않는다.
- 이미 있는 교훈이 성적과 맞지 않으면 버리고, 맞으면 남긴다. 목표는 수익을 키우는 것이다.
답은 JSON 하나만: {"lessons": ["교훈", ...], "note": "이번 복기에서 바꾼 점 한 문장"}"""


def _people(a: dict) -> list[dict]:
    if a.get("strategy") == "team":
        return list(a.get("team") or [])
    return [{"id": "solo", "role": "manager", "persona": "neutral", "temper": "mid"}]


def _agent(a: dict, m: dict) -> dict:
    sig = harness._sig_of(a, m["id"])
    ag = a.setdefault("agents", {}).get(m["id"])
    if not ag or ag.get("sig") != sig:
        # 팀원이 바뀌면 교훈은 새로 (다른 사람이므로)
        ag = a["agents"][m["id"]] = {"sig": sig, "lessons": [], "log": [], "stats": {}, "reviewedN": 0}
    return ag


async def review(a: dict, tag: str = "") -> list[str]:
    """채점하고, 새로 채점된 판단이 있는 팀원마다 교훈을 고쳐 쓴다"""
    out = []
    try:
        await score(a)
    except Exception as e:  # noqa: BLE001
        harness.state["lastError"] = f"채점 실패: {e}"[:300]
    for m in _people(a):
        ag = _agent(a, m)
        st = stats(a, m["id"], ag["sig"])
        ag["stats"] = st
        if st["n"] < MIN_SCORED or st["n"] == ag.get("reviewedN") or not ai.configured() or settings.get("emergency"):
            continue
        name = "AI 단독 매니저" if m["id"] == "solo" else harness.agent_name(m)
        cs = [c for c in a["calls"] if c["who"] == m["id"] and c.get("sig") == ag["sig"] and c.get("ret") is not None][-20:]
        val = await harness.valuation(a)
        prompt = "\n".join(
            [
                f"[나] {name} ({harness.TEMPERS[m['temper']][0]}), 계좌 '{a['name']}'",
                f"[계좌 성적] 시작 대비 {val['pnlPct']:+.2f}%, 현금 {val['cash'] / (val['total'] or 1) * 100:.0f}%",
                f"[내 성적] 채점 {st['n']}번, 맞힌 비율 {st['hit']:.0f}%, 판단 방향 평균 {st['avg']:+.2f}%",
                "[최근 판단과 결과]",
                *[_call_line(c) for c in cs],
                "[지금 교훈]",
                *([f"- {x['text']}" for x in ag["lessons"]] or ["(없음)"]),
                "",
                "교훈을 고쳐 JSON 으로.",
            ]
        )
        try:
            d = harness._parse(await ai.ask_system(REVIEW, prompt, 800), need_orders=False)
        except Exception as e:  # noqa: BLE001 - 한 명이 실패해도 계속
            ag["log"].append({"at": harness._iso(), "added": [], "removed": [], "note": f"복기 실패: {e.__class__.__name__}"})
            continue
        new = [str(x).strip()[:200] for x in d.get("lessons") or [] if str(x).strip()][:MAX_LESSONS]
        old = [x["text"] for x in ag["lessons"]]
        keep_at = {x["text"]: x["at"] for x in ag["lessons"]}
        ag["lessons"] = [{"text": x, "at": keep_at.get(x, harness._iso())} for x in new]
        ag["log"].append({"at": harness._iso(), "added": [x for x in new if x not in old], "removed": [x for x in old if x not in new], "note": str(d.get("note") or "")[:300], "hit": round(st["hit"]), "n": st["n"]})
        ag["log"] = ag["log"][-60:]
        ag["reviewedN"] = st["n"]
        ag["reviewedAt"] = harness._iso()
        out.append(name)
    harness._save()
    return out


# ---------- 운용 본부 ----------
HQ = """너는 '개미레인저' 가상 투자 계좌들을 총괄하는 운용 본부장이다. 계좌마다 AI 팀이 따로 굴린다. 목표는 가상 계좌 전체의 돈을 가장 크게 불리는 것.
할 수 있는 것 (모두 가상 돈, 코드가 그대로 적용):
- moves: 계좌 사이 현금 옮기기. 주는 계좌의 현금 안에서, 그 계좌 총평가의 절반까지. 잘하는 팀에 더 맡겨라.
- tune: 팀 계좌의 성적 나쁜 팀원 한 명의 역할·투자관·성향 바꾸기 (그 팀원의 교훈은 새로 시작).
- retire: 시작한 지 14일이 넘은 계좌 하나 해체 (보유 종목을 지금 값에 다 팔고 돈은 새 팀이나 가장 잘하는 계좌로). 계좌는 최소 2개 남긴다.
- spawn: 새 팀 계좌 만들기 (retire 와 함께, 또는 fund 로 다른 계좌 현금을 받아서). 잘하는 팀을 조금 바꾼 구성을 권한다. 계좌는 최대 6개.
- real: 사용자의 실제 계좌에 대한 조언 (돈은 움직이지 않는다. 짧고 구체적으로).
성적이 짧으면(며칠) 운일 수 있다. 근거가 약하면 아무것도 하지 않아도 된다.
역할: strategist, analyst, risk, manager (manager 는 꼭 한 명). 투자관: buffett, graham, lynch, bogle, dalio, momentum, neutral. 성향: cons, mid, aggr.
답은 JSON 하나만:
{"view": "전체 판단 두세 문장", "moves": [{"from": "paper1", "to": "paper2", "amountKrw": 1000000, "reason": "..."}], "tune": [{"account": "paper2", "member": "m3", "role": "analyst", "persona": "momentum", "temper": "aggr", "reason": "..."}], "retire": {"account": "paper1", "reason": "..."} 또는 null, "spawn": {"name": "새 팀 이름", "team": [{"role": "...", "persona": "...", "temper": "..."}], "fund": [{"from": "paper2", "amountKrw": 2000000}], "reason": "..."} 또는 null, "real": ["조언", ...]}"""


def _hq() -> dict:
    return harness.load().setdefault("hq", {"runs": [], "retired": [], "week": ""})


def _dd(eq: list[dict]) -> float:
    peak, dd = 0.0, 0.0
    for e in eq:
        peak = max(peak, e["value"])
        if peak:
            dd = min(dd, (e["value"] / peak - 1) * 100)
    return dd


def _wk(eq: list[dict], total: float) -> float:
    if not eq:
        return 0.0
    cut = (datetime.now(market.KST) - timedelta(days=7)).strftime("%Y-%m-%d")
    base = next((e["value"] for e in eq if e["day"] >= cut), eq[0]["value"])
    return (total / base - 1) * 100 if base else 0.0


def transfer(src: dict, dst: dict, amount: float, by: str, why: str = "") -> str:
    """가상 현금 옮기기. 받은 계좌의 시작 금액도 같이 늘려 수익률이 흐려지지 않게 한다"""
    amount = float(amount or 0)
    if src is dst or amount <= 0:
        return "거절: 금액이나 계좌가 잘못됨"
    total = src["cash"] + sum(p["qty"] * p["avgKrw"] for p in src["positions"].values())
    amount = min(amount, src["cash"], total * 0.5)
    amount = round(amount)
    if amount < 10_000:
        return f"거절: 옮길 수 있는 현금이 없음 ({src['name']} 현금 {src['cash']:,.0f}원)"
    src["cash"] -= amount
    src["start"] -= amount
    dst["cash"] += amount
    dst["start"] += amount
    rec = {"at": harness._iso(), "from": src["id"], "to": dst["id"], "amount": amount, "by": by, "why": why[:200]}
    for x in (src, dst):
        x.setdefault("flows", []).append(rec)
        x["flows"] = x["flows"][-100:]
    return f"옮김: {src['name']} → {dst['name']} {amount:,.0f}원"


async def _liquidate(a: dict) -> float:
    """해체: 보유 종목을 지금 값에 다 판 것으로 (수수료·세금 반영). 장 시간과 상관없이 가상으로"""
    for key, p in list(a["positions"].items()):
        try:
            price, _ = await harness.price_of(p["asset"], p["code"])
        except Exception:  # noqa: BLE001
            price = 0.0
        price = price or p["avg"]
        fx = harness._fx() if p["asset"] == "us" else 1.0
        cost = p["qty"] * price * fx
        fee = cost * (harness.FEE_KR if p["asset"] == "kr" else harness.FEE_US)
        tax = cost * harness.TAX_KR if p["asset"] == "kr" else 0.0
        a["cash"] += cost - fee - tax
        a["trades"].append({"at": harness._iso(), "side": "sell", "market": p["asset"], "code": p["code"], "name": p["name"], "qty": p["qty"], "price": price, "fx": fx if p["asset"] == "us" else None, "amount": round(cost), "fee": round(fee), "tax": round(tax), "by": "hq", "reason": "운용 본부: 계좌 해체", "realized": round(cost - fee - tax - p["qty"] * p["avgKrw"])})
        a["positions"].pop(key)
    return a["cash"]


async def _summary_lines() -> list[str]:
    lines = []
    for a in harness.load()["accounts"]:
        val = await harness.valuation(a, fetch=True)
        age = (time.time() - _ts(a["createdAt"])) / 86400
        L = harness.lim(a)
        lines.append(
            f"## {a['id']} '{a['name']}' ({'팀 ' + str(len(a.get('team') or [])) + '명' if a.get('strategy') == 'team' else 'AI 단독'}, {age:.0f}일째{', 정지됨' if not a.get('enabled') else ''})\n"
            f"총평가 {val['total']:,.0f}원, 맡은 돈 {a['start']:,.0f}원 대비 {val['pnlPct']:+.2f}%, 최근 7일 {_wk(a['equity'], val['total']):+.2f}%, 최대 낙폭 {_dd(a['equity']):.1f}%, 현금 {val['cash']:,.0f}원, 매매 {len(a['trades'])}번\n"
            f"한도: 한 종목 {L['maxPosPct']}%, 손절 {L['stopPct']}%, 범위 {L['universe']}\n"
            "보유: " + (", ".join(f"{r['name']} {r['weight']:.0f}%" for r in val["rows"][:8]) or "없음")
        )
        for m in _people(a):
            ag = (a.get("agents") or {}).get(m["id"]) or {}
            st = ag.get("stats") or {}
            nm = "AI 단독" if m["id"] == "solo" else f"{m['id']} {harness.agent_name(m)} ({harness.TEMPERS[m['temper']][0]})"
            lines.append(f"  - {nm}: 채점 {st.get('n', 0)}번, 맞힘 {st.get('hit', 0):.0f}%, 평균 {st.get('avg', 0):+.2f}%")
    return lines


def _real_ctx() -> str:
    try:
        from . import main

        return ai.context(main.get_portfolio("all"), [])
    except Exception:  # noqa: BLE001
        return "[실제 계좌] 불러오지 못함"


async def hq_run(why: str = "정기") -> dict:
    rec = {"at": harness._iso(), "why": why, "view": "", "actions": [], "real": [], "error": ""}
    hq = _hq()
    async with harness._lock:
        harness.state["running"] = "hq"
        try:
            for a in harness.load()["accounts"]:
                await score(a)
                for m in _people(a):
                    ag = _agent(a, m)
                    ag["stats"] = stats(a, m["id"], ag["sig"])
            prompt = "\n".join(["[가상 계좌들]", *await _summary_lines(), "", "[사용자 실제 계좌 (조언만)]", _real_ctx(), "", "이번 주 운용 결정을 JSON 으로."])
            d = harness._parse(await ai.ask_system(HQ, prompt, 2000), need_orders=False)
            rec["view"] = str(d.get("view") or "")[:600]
            rec["real"] = [str(x)[:300] for x in d.get("real") or []][:5]
            accts = {a["id"]: a for a in harness.load()["accounts"]}
            act = rec["actions"]
            for mv in (d.get("moves") or [])[:6]:
                s, t = accts.get(mv.get("from")), accts.get(mv.get("to"))
                act.append(transfer(s, t, mv.get("amountKrw"), "hq", mv.get("reason") or "") + f" · {mv.get('reason', '')}" if s and t else f"거절: 없는 계좌 ({mv.get('from')} → {mv.get('to')})")
            for tu in (d.get("tune") or [])[:3]:
                a = accts.get(tu.get("account"))
                if not a or a.get("strategy") != "team":
                    act.append(f"거절: 팀 계좌가 아님 ({tu.get('account')})")
                    continue
                team = [dict(m) for m in a["team"]]
                i = next((k for k, m in enumerate(team) if m["id"] == tu.get("member")), None)
                if i is None:
                    act.append(f"거절: 없는 팀원 ({tu.get('member')})")
                    continue
                before = harness.agent_name(team[i])
                for k in ("role", "persona", "temper"):
                    if tu.get(k):
                        team[i][k] = tu[k]
                try:
                    a["team"] = harness.check_team(team)
                except ValueError as e:
                    act.append(f"거절: {e}")
                    continue
                a["debate"] = {}
                (a.get("agents") or {}).pop(team[i]["id"], None)
                act.append(f"팀원 교체: {a['name']} {before} → {harness.agent_name(a['team'][i])} ({harness.TEMPERS[a['team'][i]['temper']][0]}) · {tu.get('reason', '')}")
            freed, retired_name = 0.0, ""
            rt = d.get("retire") or None
            if isinstance(rt, dict) and rt.get("account") in accts:
                a = accts[rt["account"]]
                age = (time.time() - _ts(a["createdAt"])) / 86400
                if age < RETIRE_AFTER_D:
                    act.append(f"거절: {a['name']} 은 {age:.0f}일째라 해체하지 않음 ({RETIRE_AFTER_D}일부터)")
                elif len(accts) <= 2 and not d.get("spawn"):
                    act.append("거절: 계좌는 최소 2개 남긴다")
                else:
                    val = await harness.valuation(a)
                    freed = await _liquidate(a)
                    a["cash"] = 0.0
                    retired_name = a["name"]
                    hq["retired"].append({"at": harness._iso(), "id": a["id"], "name": a["name"], "team": [harness.agent_name(m) for m in a.get("team") or []], "pnlPct": round(val["pnlPct"], 2), "start": a["start"], "reason": str(rt.get("reason") or "")[:300]})
                    harness.data["accounts"] = [x for x in harness.data["accounts"] if x["id"] != a["id"]]
                    accts.pop(a["id"])
                    act.append(f"해체: {a['name']} ({val['pnlPct']:+.2f}%), 회수 {freed:,.0f}원 · {rt.get('reason', '')}")
            sp = d.get("spawn") or None
            new_acct = None
            if isinstance(sp, dict) and sp.get("team"):
                if len(harness.data["accounts"]) >= 6:
                    act.append("거절: 계좌는 6개까지")
                else:
                    try:
                        team = harness.check_team(sp["team"])
                        new_acct = harness.create(str(sp.get("name") or "본부가 만든 팀")[:20], "team", team=team, start=0)
                        new_acct["cash"] = new_acct["start"] = round(freed)
                        new_acct["bornFrom"] = {"at": harness._iso(), "reason": str(sp.get("reason") or "")[:300], "replaced": retired_name}
                        freed = 0.0
                        for f in (sp.get("fund") or [])[:3]:
                            s = accts.get(f.get("from"))
                            if s:
                                act.append(transfer(s, new_acct, f.get("amountKrw"), "hq", "새 팀 자금"))
                        act.append(f"새 팀: {new_acct['name']} ({', '.join(harness.agent_name(m) for m in team)}), 시작 {new_acct['start']:,.0f}원 · {sp.get('reason', '')}")
                    except ValueError as e:
                        act.append(f"거절: 새 팀 ({e})")
            if new_acct and new_acct["start"] < 100_000:
                harness.data["accounts"] = [x for x in harness.data["accounts"] if x["id"] != new_acct["id"]]
                act.append("거절: 새 팀에 줄 돈이 없어 만들지 않음")
                freed += new_acct["cash"]
            if freed > 0:
                # 해체한 돈이 남으면 가장 잘하는 계좌로
                best = max(harness.data["accounts"], key=lambda x: (x["cash"] + sum(p["qty"] * p["avgKrw"] for p in x["positions"].values())) / (x["start"] or 1))
                best["cash"] += freed
                best["start"] += freed
                act.append(f"회수한 {freed:,.0f}원 → {best['name']}")
        except Exception as e:  # noqa: BLE001
            rec["error"] = f"{e.__class__.__name__}: {e}"[:300]
        finally:
            harness.state["running"] = ""
    hq["runs"].append(rec)
    hq["runs"] = hq["runs"][-30:]
    harness._save()
    if telegram.configured() and not rec["error"]:
        try:
            await telegram.send("\n".join(["[운용 본부] " + rec["view"][:300], *[f"- {x[:120]}" for x in rec["actions"]], *[f"실계좌 조언: {x[:150]}" for x in rec["real"]]]), silent=True)
        except Exception:  # noqa: BLE001
            pass
    return rec


async def hq_tick() -> None:
    """매주 토요일 10:00 (한국 시간) 한 번"""
    n = datetime.now(market.KST)
    week = n.strftime("%G-W%V")
    hq = _hq()
    if n.weekday() == 5 and n.hour >= 10 and hq.get("week") != week and ai.configured() and not settings.get("emergency"):
        hq["week"] = week
        harness._save()
        await hq_run()


def hq_view() -> dict:
    hq = _hq()
    n = datetime.now(market.KST)
    nxt = n + timedelta(days=(5 - n.weekday()) % 7)
    nxt = nxt.replace(hour=10, minute=0, second=0, microsecond=0)
    if nxt <= n or hq.get("week") == n.strftime("%G-W%V") and n.weekday() == 5:
        nxt += timedelta(days=7)
    return {"runs": hq["runs"][-10:][::-1], "retired": hq["retired"][-10:][::-1], "next": nxt.isoformat(timespec="minutes"), "running": harness.state["running"] == "hq"}
