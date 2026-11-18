r"""텔레그램 봇 연결 확인. 실행: .venv\Scripts\python -m app.telegram_setup

1) .env 의 TELEGRAM_BOT_TOKEN 으로 봇에 접속되는지 본다
2) 봇에게 온 메시지에서 내 chat id 를 찾아 보여 준다
3) .env 의 TELEGRAM_CHAT_ID 가 비어 있고 찾은 대화가 하나뿐이면 그 값을 써 넣는다
4) 내 대화방으로 시험 메시지를 보낸다
서버가 켜져 있으면 서버가 메시지를 먼저 가져갈 수 있으니 서버를 끄고 실행한다.
"""

import asyncio
import os
import re

from . import config, telegram


async def main() -> None:
    if not config.TELEGRAM_BOT_TOKEN:
        print("backend/.env 의 TELEGRAM_BOT_TOKEN= 뒤에 BotFather 가 준 토큰을 쓰고 다시 실행하세요.")
        return
    try:
        me = await telegram.call("getMe")
    except RuntimeError as e:
        print(f"봇에 접속하지 못했습니다: {e}\n토큰을 다시 확인하세요.")
        return
    print(f"봇 확인: @{me.get('username')}")
    ups = await telegram.call("getUpdates", timeout=0)
    chats: dict[str, str] = {}
    for u in ups:
        m = u.get("message") or {}
        c = m.get("chat") or {}
        if c.get("type") == "private":
            chats[str(c["id"])] = " ".join(x for x in (c.get("first_name"), c.get("last_name")) if x) or c.get("username") or "?"
    if not chats:
        print(f"봇에게 온 메시지가 없습니다. 텔레그램에서 @{me.get('username')} 를 찾아 아무 말이나 보낸 뒤 다시 실행하세요.")
        return
    print("봇에게 말을 건 사람:")
    for cid, name in chats.items():
        print(f"  chat id {cid}  ({name})")
    cid = config.TELEGRAM_CHAT_ID
    if not cid:
        if len(chats) != 1:
            print("여러 명이라 자동으로 고르지 않았습니다. 내 chat id 를 .env 의 TELEGRAM_CHAT_ID= 뒤에 쓰세요.")
            return
        cid = next(iter(chats))
        env = os.getenv("GR_ENV_FILE") or str(config.BASE / ".env")
        text = open(env, encoding="utf-8-sig").read()
        if re.search(r"(?m)^TELEGRAM_CHAT_ID=", text):
            text = re.sub(r"(?m)^TELEGRAM_CHAT_ID=.*$", f"TELEGRAM_CHAT_ID={cid}", text)
        else:
            text = text.rstrip("\n") + f"\nTELEGRAM_CHAT_ID={cid}\n"
        open(env, "w", encoding="utf-8").write(text)
        config.TELEGRAM_CHAT_ID = cid
        print(f".env 에 TELEGRAM_CHAT_ID={cid} 를 써 넣었습니다.")
    try:
        await telegram.send("[개미레인저] 연결됐습니다. 앞으로 로그인할 때 이 대화방으로 승인 요청이 옵니다.")
        print("시험 메시지를 보냈습니다. 텔레그램을 확인하세요. 이제 서버를 다시 켜면 로그인에 텔레그램 승인이 필요합니다.")
    except RuntimeError as e:
        print(f"시험 메시지를 보내지 못했습니다: {e}")
    await telegram.close()


if __name__ == "__main__":
    asyncio.run(main())
