"""로그인 (한 사람용). 비밀번호는 scrypt 해시로만 .env 에 둔다. 세션은 서명한 쿠키."""

import hashlib
import hmac
import secrets
import time

from fastapi import HTTPException, Request, Response

from . import config

COOKIE = "gr_session"
_fails: dict[str, list[float]] = {}  # IP 별 실패 시각
MAX_FAILS = 5
LOCK_SEC = 600


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
    mac = hmac.new(config.SESSION_SECRET.encode(), str(exp).encode(), hashlib.sha256).hexdigest()
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


def login(req: Request, res: Response, password: str) -> None:
    if not config.login_configured():
        raise HTTPException(503, "서버에 로그인 비밀번호가 아직 설정되지 않았습니다 (backend/.env 의 APP_PASSWORD)")
    ip = _ip(req)
    now = time.time()
    recent = [t for t in _fails.get(ip, []) if now - t < LOCK_SEC]
    if len(recent) >= MAX_FAILS:
        raise HTTPException(429, "로그인 실패가 많아 10분 동안 막혔습니다")
    if not check_password(password, config.APP_PASSWORD_HASH):
        _fails[ip] = recent + [now]
        raise HTTPException(401, "비밀번호가 맞지 않습니다")
    _fails.pop(ip, None)
    exp = int(now + config.SESSION_HOURS * 3600)
    res.set_cookie(COOKIE, _sign(exp), max_age=config.SESSION_HOURS * 3600, httponly=True, samesite="strict", secure=config.COOKIE_SECURE, path="/")


def logout(res: Response) -> None:
    res.delete_cookie(COOKIE, path="/")
