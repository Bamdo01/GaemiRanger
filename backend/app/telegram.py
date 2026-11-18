"""텔레그램 봇: 로그인 승인 요청을 보내고, [승인]/[거절] 버튼 누름을 받는다.

- 봇 토큰과 내 chat id 는 .env 에만 둔다 (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID).
- 서버가 집 PC 에 있어도 되게 웹훅 대신 getUpdates(긴 폴링)로 받는다.
- 내 chat id 가 아닌 사람이 누른 버튼·보낸 말은 모두 무시한다.
"""

import asyncio
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

import httpx

from . import config

KST = timezone(timedelta(hours=9))


def now_text(fmt: str = "%H:%M:%S") -> str:
    """서버가 어느 나라에 있어도 한국 시각으로"""
    return datetime.now(KST).strftime(fmt)


_client: httpx.AsyncClient | None = None
# 버튼을 누르면 부를 함수: (요청 id, 승인 여부) → 결과 글자 (메시지에 덧붙임). auth 가 등록한다
on_decision: Callable[[str, bool], str] | None = None
last_error = ""


def configured() -> bool:
    return bool(config.TELEGRAM_BOT_TOKEN and config.TELEGRAM_CHAT_ID)


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(40, connect=10))
    return _client


async def call(method: str, **params) -> dict:
    """텔레그램 Bot API 호출. 실패하면 RuntimeError (토큰은 메시지에 넣지 않는다)"""
    url = f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/{method}"
    try:
        r = await _http().post(url, json=params)
        d = r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise RuntimeError(f"텔레그램에 연결하지 못했습니다 ({e.__class__.__name__})") from None
    if not d.get("ok"):
        raise RuntimeError(f"텔레그램 오류 {d.get('error_code')}: {d.get('description')}")
    return d["result"]


async def send(text: str, buttons: list[tuple[str, str]] | None = None) -> int:
    """내 대화방에 보내고 message_id 를 돌려준다. buttons = [(글자, callback_data)]"""
    p: dict = {"chat_id": config.TELEGRAM_CHAT_ID, "text": text}
    if buttons:
        p["reply_markup"] = {"inline_keyboard": [[{"text": t, "callback_data": d} for t, d in buttons]]}
    return (await call("sendMessage", **p))["message_id"]


async def notify(text: str) -> None:
    """알림만 (실패해도 로그인 흐름은 막지 않는다)"""
    global last_error
    if not configured():
        return
    try:
        await send(text)
    except RuntimeError as e:
        last_error = f"{now_text()} {e}"


async def edit(message_id: int, text: str) -> None:
    try:
        await call("editMessageText", chat_id=config.TELEGRAM_CHAT_ID, message_id=message_id, text=text)
    except RuntimeError:
        pass


async def handle_update(u: dict) -> None:
    cq = u.get("callback_query")
    if not cq:
        return  # 일반 메시지는 지금은 쓰지 않는다 (나중에 알림 명령)
    me = str(config.TELEGRAM_CHAT_ID)
    msg = cq.get("message") or {}
    from_me = str((cq.get("from") or {}).get("id")) == me and str((msg.get("chat") or {}).get("id")) == me
    data = cq.get("data") or ""
    result = "처리할 수 없는 버튼입니다"
    if from_me and ":" in data and on_decision:
        act, rid = data.split(":", 1)
        if act in ("ok", "no"):
            result = on_decision(rid, act == "ok")
    try:
        await call("answerCallbackQuery", callback_query_id=cq.get("id"), text=result[:180])
    except RuntimeError:
        pass
    if from_me and msg.get("message_id"):
        await edit(msg["message_id"], f"{msg.get('text', '')}\n\n→ {result} ({now_text()})")


async def poll_forever() -> None:
    global last_error
    offset = 0
    while True:
        if not configured():
            await asyncio.sleep(30)
            continue
        try:
            ups = await call("getUpdates", offset=offset, timeout=25, allowed_updates=["callback_query", "message"])
            for u in ups:
                offset = max(offset, u["update_id"] + 1)
                await handle_update(u)
        except RuntimeError as e:
            last_error = f"{now_text()} {e}"
            await asyncio.sleep(5)
        except Exception as e:  # noqa: BLE001 - 폴링이 죽지 않게
            last_error = f"{now_text()} {e.__class__.__name__}: {e}"
            await asyncio.sleep(5)


async def close() -> None:
    if _client is not None:
        await _client.aclose()

