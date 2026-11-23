"""로그인 (한 사람용). 세션은 서명한 쿠키.

텔레그램이 설정돼 있으면 2단계:
  1) 비밀번호가 맞으면 텔레그램으로 [승인][거절] 요청을 보낸다 (2분)
  2) 화면은 승인을 기다리다가, 승인되면 그때 쿠키를 받는다
텔레그램을 못 쓸 때는 비밀번호 + 복구 코드(한 번 쓰면 끝)로 들어간다.
"""

import hashlib
import hmac
import json
import secrets
import time

from fastapi import HTTPException, Request, Response

from . import config, telegram

COOKIE = "gr_session"
_fails: dict[str, list[float]] = {}  # IP 별 실패 시각
MAX_FAILS = 5
LOCK_SEC = 600
# 모든 IP 를 합친 실패: 15분에 20번 넘으면 15분 동안 전체 막음
_global: list[float] = []
GLOBAL_MAX = 20
GLOBAL_SEC = 900


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt$16384$8$1${salt.hex()}${h.hex()}"


def check_password(pw: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, h = stored.split("$")
        if algo != "scrypt":
            return False
        got = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=len(bytes.fromhex(h)))
        return hmac.compare_digest(got, bytes.fromhex(h))
    except (ValueError, TypeError):
        return False


def _sign(exp: int) -> str:
    from . import settings

    # 설정의 "모든 기기 로그아웃"을 누르면 sessionNonce 가 바뀌어 예전 쿠키가 모두 무효
    key = (config.SESSION_SECRET + config.PASSWORD_FINGERPRINT + settings.get("sessionNonce")).encode()
    mac = hmac.new(key, str(exp).encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{mac}"


def _valid(token: str | None) -> bool:
    if not token or "." not in token or not config.login_configured():
        return False
    exp_s, _ = token.split(".", 1)
    if not exp_s.isdigit() or int(exp_s) < time.time():
        return False
    return hmac.compare_digest(_sign(int(exp_s)), token)


def logged_in(req: Request) -> bool:
    return _valid(req.cookies.get(COOKIE))


def require_login(req: Request) -> None:
    if not logged_in(req):
        raise HTTPException(401, "로그인이 필요합니다")


def _ip(req: Request) -> str:
    return req.client.host if req.client else "?"


def _activity(req: Request, text: str, result: str) -> None:
    from . import activity

    activity.log("login", text, by=f"IP {_ip(req)} · {_short_agent(req.headers.get('user-agent', ''))}", result=result)


def _set_session(res: Response) -> None:
    exp = int(time.time() + config.SESSION_HOURS * 3600)
    res.set_cookie(COOKIE, _sign(exp), max_age=config.SESSION_HOURS * 3600, httponly=True, samesite="strict", secure=config.COOKIE_SECURE, path="/")


async def _check_password_or_fail(req: Request, password: str, extra_ok: bool = True) -> None:
    """잠금 확인 + 비밀번호 확인. 틀리면 실패로 센다 (extra_ok=False 면 비밀번호가 맞아도 실패)"""
    if not config.login_configured():
        raise HTTPException(503, "서버에 로그인 비밀번호가 아직 설정되지 않았습니다 (backend/.env 의 APP_PASSWORD)")
    ip = _ip(req)
    now = time.time()
    recent = [t for t in _fails.get(ip, []) if now - t < LOCK_SEC]
    if len(recent) >= MAX_FAILS:
        raise HTTPException(429, "로그인 실패가 많아 10분 동안 막혔습니다")
    # IP 를 바꿔 가며 시도하는 것을 막는 전체 한도 (인터넷에 열 때)
    _global[:] = [t for t in _global if now - t < GLOBAL_SEC]
    if len(_global) >= GLOBAL_MAX:
        raise HTTPException(429, "로그인 실패가 너무 많아 잠시 모든 로그인을 막았습니다. 15분 뒤 다시 해 주세요")
    if not check_password(password, config.APP_PASSWORD_HASH) or not extra_ok:
        _fails[ip] = recent + [now]
        _global.append(now)
        _activity(req, "로그인 실패", "실패")
        if len(_fails[ip]) >= MAX_FAILS:
            await telegram.notify(f"[개미레인저] 로그인 실패 {MAX_FAILS}번 → 10분 잠금\n시각 {telegram.now_text()}\nIP {ip}")
        raise HTTPException(401, "비밀번호가 맞지 않습니다" if extra_ok else "비밀번호 또는 복구 코드가 맞지 않습니다")
    _fails.pop(ip, None)


# ---------- 텔레그램 승인 ----------
WAIT_SEC = 120
MAX_PENDING = 3
# 요청 id(버튼에 실리는 짧은 값) → 상태. 화면은 id 가 아니라 따로 받은 비밀 값(secret)으로 묻는다
_pending: dict[str, dict] = {}


def _sweep() -> None:
    now = time.time()
    for k in [k for k, p in _pending.items() if now - p["at"] > WAIT_SEC + 60]:
        _pending.pop(k, None)


def _decide(rid: str, ok: bool) -> str:
    p = _pending.get(rid)
    if not p:
        return "없거나 이미 끝난 요청입니다"
    if p["state"] != "wait":
        return "이미 처리한 요청입니다"
    if time.time() - p["at"] > WAIT_SEC:
        p["state"] = "expired"
        return "시간이 지나 취소된 요청입니다"
    p["state"] = "ok" if ok else "denied"
    return "승인했습니다" if ok else "거절했습니다"


telegram.on_decision = _decide


def _short_agent(ua: str) -> str:
    ua = ua or "?"
    os_ = next((n for k, n in (("Windows", "Windows"), ("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Mac OS", "Mac"), ("Linux", "Linux")) if k in ua), "")
    br = next((n for k, n in (("Edg/", "Edge"), ("Whale", "Whale"), ("SamsungBrowser", "삼성 인터넷"), ("Chrome/", "Chrome"), ("Firefox/", "Firefox"), ("Safari/", "Safari")) if k in ua), "")
    return " · ".join(x for x in (os_, br) if x) or ua[:60]


async def login(req: Request, res: Response, password: str) -> dict:
    await _check_password_or_fail(req, password)
    if not (telegram.configured() and config.TELEGRAM_LOGIN_APPROVAL):
        _activity(req, "로그인", "성공")
        _set_session(res)
        return {"ok": True}
    _sweep()
    if sum(1 for p in _pending.values() if p["state"] == "wait" and time.time() - p["at"] <= WAIT_SEC) >= MAX_PENDING:
        raise HTTPException(429, "승인을 기다리는 요청이 이미 여러 개 있습니다. 텔레그램에서 처리하거나 2분 뒤 다시 해 주세요")
    rid = secrets.token_urlsafe(9)
    secret = secrets.token_urlsafe(32)
    text = (
        "[개미레인저] 로그인 요청\n"
        f"시각 {telegram.now_text('%Y-%m-%d %H:%M:%S')}\n"
        f"IP {_ip(req)}\n"
        f"기기 {_short_agent(req.headers.get('user-agent', ''))}\n"
        "내가 한 게 아니면 [거절]을 누르고 비밀번호를 바꾸세요. 2분 안에 누르지 않으면 취소됩니다."
    )
    try:
        await telegram.send(text, [("승인", f"ok:{rid}"), ("거절", f"no:{rid}")])
    except RuntimeError as e:
        raise HTTPException(503, f"텔레그램으로 승인 요청을 보내지 못했습니다. 복구 코드로 들어갈 수 있습니다. ({e})") from None
    _pending[rid] = {"secret": secret, "at": time.time(), "state": "wait"}
    return {"wait": secret, "seconds": WAIT_SEC}


def wait(res: Response, secret: str) -> dict:
    """화면이 2초마다 묻는다. 승인됐으면 이때 쿠키를 준다 (한 번만)"""
    rid = next((k for k, p in _pending.items() if hmac.compare_digest(p["secret"], secret or "")), None)
    if rid is None:
        return {"state": "gone"}
    p = _pending[rid]
    if p["state"] == "wait" and time.time() - p["at"] > WAIT_SEC:
        p["state"] = "expired"
    if p["state"] == "ok":
        _pending.pop(rid, None)
        _set_session(res)
    elif p["state"] in ("denied", "expired"):
        _pending.pop(rid, None)
    return {"state": p["state"], "left": max(0, int(WAIT_SEC - (time.time() - p["at"])))}


# ---------- 복구 코드 ----------
CODES_FILE = config.DATA / "recovery_codes.json"


def _code_hash(code: str) -> str:
    c = code.replace("-", "").replace(" ", "").lower()
    return hashlib.sha256((config.SESSION_SECRET + ":" + c).encode()).hexdigest()


def make_recovery_codes(n: int = 8) -> list[str]:
    """새 복구 코드를 만들고 예전 것은 모두 버린다. 파일에는 해시만 남긴다"""
    abc = "abcdefghjkmnpqrstuvwxyz23456789"  # 헷갈리는 글자(i l o 0 1) 뺌
    codes = ["".join(secrets.choice(abc) for _ in range(4)) + "-" + "".join(secrets.choice(abc) for _ in range(4)) for _ in range(n)]
    CODES_FILE.write_text(json.dumps({"made": time.time(), "unused": [_code_hash(c) for c in codes]}), "utf-8")
    return codes


def recovery_left() -> int:
    try:
        return len(json.loads(CODES_FILE.read_text("utf-8"))["unused"])
    except (OSError, ValueError, KeyError):
        return 0


def _use_code(code: str) -> bool:
    try:
        d = json.loads(CODES_FILE.read_text("utf-8"))
    except (OSError, ValueError):
        return False
    h = _code_hash(code)
    hit = next((x for x in d.get("unused", []) if hmac.compare_digest(x, h)), None)
    if not hit:
        return False
    d["unused"].remove(hit)
    CODES_FILE.write_text(json.dumps(d), "utf-8")
    return True


async def login_recovery(req: Request, res: Response, password: str, code: str) -> dict:
    # 비밀번호가 맞을 때만 코드를 쓴다 (비밀번호가 틀리면 코드를 소모하지 않음)
    now = time.time()
    if len([t for t in _fails.get(_ip(req), []) if now - t < LOCK_SEC]) >= MAX_FAILS:
        raise HTTPException(429, "로그인 실패가 많아 10분 동안 막혔습니다")
    ok_pw = config.login_configured() and check_password(password, config.APP_PASSWORD_HASH)
    await _check_password_or_fail(req, password, extra_ok=ok_pw and _use_code(code))
    _set_session(res)
    left = recovery_left()
    await telegram.notify(f"[개미레인저] 복구 코드로 로그인했습니다\n시각 {telegram.now_text('%Y-%m-%d %H:%M:%S')}\nIP {_ip(req)}\n남은 복구 코드 {left}개")
    return {"ok": True, "left": left}


def logout(res: Response) -> None:
    res.delete_cookie(COOKIE, path="/")
