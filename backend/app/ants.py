"""개미 캐릭터 (2026-11-26 사용자: 개미 한 명 한 명에게 역할을 주고 캐릭터를 만들어 팀에 넣기)

- 개미: 이름, 역할, 투자관, 성향, 말버릇, 직접 쓰는 투자 철학(300자), 얼굴 색. harness.json 의 data["ants"]
- 계좌의 팀은 개미 id 목록 ({"ant": "ant3"}). 한 개미가 여러 계좌 팀에 들어갈 수 있다
- 성적·교훈·발언 기록은 개미를 따라다닌다 (팀을 옮겨도 그대로)
- 지우지 않고 휴직(rest)시킨다. 휴직한 개미는 팀에 넣을 수 없다
"""

from datetime import datetime

from . import ai, harness, market

COLORS = ["#c0392b", "#d35400", "#b7950b", "#27ae60", "#16a085", "#2980b9", "#8e44ad", "#5d4037"]
NICK = {"buffett": "버핏", "graham": "그레이엄", "lynch": "린치", "bogle": "보글", "dalio": "달리오", "momentum": "모멘텀", "neutral": ""}
ROLE_NICK = {"strategist": "전략", "analyst": "분석", "risk": "지킴", "manager": "결정"}


def _iso() -> str:
    return datetime.now(market.KST).isoformat(timespec="seconds")


def all_() -> list[dict]:
    return harness.load().setdefault("ants", [])


def get(aid: str) -> dict | None:
    return next((x for x in all_() if x["id"] == aid), None)


def _next_id() -> str:
    n = 1
    ids = {x["id"] for x in all_()}
    while f"ant{n}" in ids:
        n += 1
    return f"ant{n}"


def _name_for(role: str, persona: str) -> str:
    base = f"{NICK.get(persona) or ROLE_NICK[role]} 개미"
    names = {x["name"] for x in all_()}
    if base not in names:
        return base
    n = 2
    while f"{base} {n}" in names:
        n += 1
    return f"{base} {n}"


def check(f: dict, partial: bool = False) -> dict:
    """입력 검사. 잘못되면 ValueError"""
    out = {}
    if not partial or "name" in f:
        name = str(f.get("name") or "").strip()[:12]
        if not name:
            raise ValueError("이름을 적어 주세요 (12자 이내)")
        out["name"] = name
    for k, cat in (("role", harness.ROLES), ("persona", harness.PERSONAS), ("temper", harness.TEMPERS)):
        if not partial or k in f:
            if f.get(k) not in cat:
                raise ValueError(f"{k} 가 잘못됨")
            out[k] = f[k]
    if not partial or "motto" in f:
        out["motto"] = str(f.get("motto") or "").strip()[:60]
    if not partial or "philosophy" in f:
        out["philosophy"] = str(f.get("philosophy") or "").strip()[:300]
    if not partial or "color" in f:
        try:
            out["color"] = max(0, min(len(COLORS) - 1, int(f.get("color") or 0)))
        except (TypeError, ValueError):
            out["color"] = 0
    return out


def create(f: dict, by: str = "사용자") -> dict:
    c = check({**f, "name": f.get("name") or _name_for(f.get("role", "analyst"), f.get("persona", "neutral"))})
    if any(x["name"] == c["name"] for x in all_()):
        raise ValueError("같은 이름의 개미가 이미 있습니다")
    ant = {"id": _next_id(), **c, "status": "active", "by": by, "createdAt": _iso(), "lessons": [], "log": [], "stats": {}, "reviewedN": 0}
    all_().append(ant)
    return ant


def update(ant: dict, f: dict) -> None:
    c = check(f, partial=True)
    if "name" in c and any(x["name"] == c["name"] and x is not ant for x in all_()):
        raise ValueError("같은 이름의 개미가 이미 있습니다")
    ant.update(c)


def teams_of(aid: str) -> list[dict]:
    return [a for a in harness.load()["accounts"] if any(m.get("ant") == aid for m in a.get("team") or [])]


def set_status(ant: dict, status: str) -> None:
    if status not in ("active", "rest"):
        raise ValueError("상태가 잘못됨")
    if status == "rest" and teams_of(ant["id"]):
        raise ValueError("팀에 들어가 있는 개미는 먼저 팀에서 빼야 휴직할 수 있습니다: " + ", ".join(a["name"] for a in teams_of(ant["id"])))
    ant["status"] = status


def resolve(m: dict) -> dict | None:
    """팀 칸 {"ant": id} → 판단에 쓰는 팀원 (개미 정보 포함)"""
    ant = get(m.get("ant", ""))
    if not ant:
        return None
    return {"id": ant["id"], "ant": ant["id"], "role": ant["role"], "persona": ant["persona"], "temper": ant["temper"], "name": ant["name"], "motto": ant.get("motto", ""), "philosophy": ant.get("philosophy", ""), "color": ant.get("color", 0)}


def members(a: dict) -> list[dict]:
    return [r for m in a.get("team") or [] if (r := resolve(m))]


def check_team(team: list) -> list[dict]:
    """팀 검사: 있는 개미, 일하는 중, 겹치지 않음, 최종 결정자 꼭 한 명, 1~6명"""
    out, seen = [], set()
    for x in team[:6]:
        aid = x.get("ant") if isinstance(x, dict) else str(x)
        ant = get(aid or "")
        if not ant:
            raise ValueError(f"없는 개미: {aid}")
        if ant["status"] != "active":
            raise ValueError(f"{ant['name']} 은 휴직 중입니다")
        if aid in seen:
            raise ValueError(f"{ant['name']} 이 두 번 들어감")
        seen.add(aid)
        out.append({"ant": aid})
    if sum(1 for m in out if get(m["ant"])["role"] == "manager") != 1:
        raise ValueError("최종 결정자 역할의 개미가 꼭 한 명 있어야 합니다")
    return out


# ---------- 옛 팀(자리 m1..)을 개미로 옮기기 (한 번) ----------
def migrate(data: dict) -> None:
    if data.get("antsMigrated"):
        return
    data.setdefault("ants", [])
    for a in data.get("accounts", []):
        mapping: dict[str, str] = {}
        old = a.get("team") or []
        if a.get("strategy") != "team" or not old:
            old = [{"id": "solo", "role": "manager", "persona": "neutral", "temper": "mid"}]
        new_team = []
        mgr_old = next((m["id"] for m in old if m.get("role") == "manager"), "")
        for i, m in enumerate(old):
            if "ant" in m:
                new_team.append(m)
                continue
            ant = create({"role": m["role"], "persona": m["persona"], "temper": m["temper"], "color": (len(data["ants"])) % len(COLORS), "name": "혼자 개미" if m["id"] == "solo" and not get_by_name("혼자 개미") else ""}, by="기본")
            ag = (a.get("agents") or {}).get(m["id"]) or {}
            for k in ("lessons", "log", "stats", "reviewedN", "reviewedAt"):
                if k in ag:
                    ant[k] = ag[k]
            mapping[m["id"]] = ant["id"]
            new_team.append({"ant": ant["id"]})
        a["team"] = new_team
        a.pop("agents", None)
        for c in a.get("calls") or []:
            c["who"] = mapping.get(c["who"], c["who"])
        for d in a.get("decisions") or []:
            for s in d.get("debate") or []:
                s["id"] = mapping.get(s["id"], s["id"])
            if d.get("managerId"):
                d["managerId"] = mapping.get(d["managerId"], d["managerId"])
            elif d.get("view") and mgr_old in mapping:
                d["managerId"] = mapping[mgr_old]  # 결정자 표시가 생기기 전 판단도 결정자 개미 기록으로
        for deb in (a.get("debate") or {}).values():
            for s in deb.get("talk") or []:
                s["id"] = mapping.get(s["id"], s["id"])
    data["antsMigrated"] = True


def get_by_name(name: str) -> dict | None:
    return next((x for x in all_() if x["name"] == name), None)


# ---------- AI 로 칸 채우기 ----------
GEN = """너는 가상 투자 팀에 들어갈 개미 캐릭터를 만든다. 사용자가 준 설명에 맞춰 JSON 하나만 답한다.
역할(role): strategist 시장 전략가, analyst 종목 분석가, risk 리스크 관리자, manager 최종 결정자
투자관(persona): buffett, graham, lynch, bogle, dalio, momentum, neutral
성향(temper): cons 보수, mid 중립, aggr 공격
{"name": "개미 이름 (12자 이내, 끝에 '개미'를 붙이면 좋다)", "role": "...", "persona": "...", "temper": "...", "motto": "말버릇 한 문장 (40자 이내)", "philosophy": "이 개미의 투자 철학 2~3문장 (판단 지시문에 들어간다. 구체적으로: 무엇을 사고 언제 팔지)", "color": 0~7}"""


async def generate(hint: str) -> dict:
    """설명을 받아 개미 초안을 만든다 (저장하지 않음)"""
    taken = ", ".join(x["name"] for x in all_())
    text = await ai.ask_system(GEN, f"[사용자 설명] {hint.strip()[:300] or '아무거나 재미있게'}\n[이미 있는 이름] {taken or '없음'}", 600)
    d = harness._parse(text, need_orders=False)
    d.setdefault("role", "analyst")
    d.setdefault("persona", "neutral")
    d.setdefault("temper", "mid")
    return check(d)


def view(ant: dict) -> dict:
    return {**{k: ant.get(k) for k in ("id", "name", "role", "persona", "temper", "motto", "philosophy", "color", "status", "by", "createdAt", "reviewedAt")}, "lessons": ant.get("lessons") or [], "log": (ant.get("log") or [])[-30:][::-1], "stats": ant.get("stats") or {}, "teams": [{"id": a["id"], "name": a["name"]} for a in teams_of(ant["id"])], "title": harness.agent_title(ant)}


