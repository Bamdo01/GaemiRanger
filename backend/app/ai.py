"""AI 리뷰·질문 (Claude). 내 자산 화면의 "AI 리뷰"와 "AI에게 묻기".

- 원칙 (PLAN.md): AI 에게 주문 도구를 주지 않는다. 읽기 전용 포트폴리오 요약만 보낸다
- 답은 사라·팔라는 지시 대신 관점과 근거 (docs/pages/assets.md)
- 2026-11-23 사용자: API 키 대신 Claude Code 로. 서버의 `claude -p` 를 도구 없이(--tools "") 부른다
  인증은 사용자의 Claude 구독: `claude setup-token` 으로 만든 토큰을 .env 의 CLAUDE_CODE_OAUTH_TOKEN 에
- Claude Code 가 없고 ANTHROPIC_API_KEY 가 있으면 API 로 (예전 방식)
- 비용 보호: 하루 AI_DAILY_LIMIT 번 (기본 100)
"""

import asyncio
import json
import os
import shutil
from collections.abc import AsyncIterator
from datetime import datetime

import anthropic
from fastapi import HTTPException
from pydantic import BaseModel

from . import config, market

INVESTORS = {
    "buffett": "워런 버핏 (좋은 기업을 오래, 몰아서)",
    "graham": "벤저민 그레이엄 (싸게 사기, 안전마진)",
    "lynch": "피터 린치 (아는 기업, 적당한 가격의 성장)",
    "bogle": "존 보글 (지수에 분산, 낮은 비용)",
    "dalio": "레이 달리오 (자산 배분, 위험 균형)",
}

# 바뀌지 않는 부분 (캐시됨). 포트폴리오 숫자는 매번 따로 붙인다
SYSTEM = """너는 '개미레인저'라는 개인 자산 관리 사이트 안의 투자 도우미다. 사용자는 주식을 잘 모르는 편인 한국 개인 투자자다.

할 일:
- 아래에 주는 사용자의 실제 포트폴리오 숫자를 근거로, 사용자가 고른 투자자의 관점에서 답한다.
- 답은 한국어, 짧고 쉽게. 전문 용어는 처음 쓸 때 한 줄로 풀어 쓴다. 꾸민 말이나 과장, 응원 문구는 쓰지 않는다.
- 숫자를 말할 때는 주어진 데이터에 있는 숫자만 쓴다. 데이터에 없는 시세, 뉴스, 실적은 지어내지 말고 "데이터에 없음"이라고 말한다.

지키는 선:
- "사라 / 팔아라 / 지금 매수" 같은 지시는 하지 않는다. 대신 그 관점이라면 무엇을 확인할지, 어떤 위험과 선택지가 있는지, 근거와 함께 말한다.
- 너는 주문을 낼 수 없고 내지 않는다. 주문은 사용자가 화면에서 직접 확인하고 낸다. 규칙(손절·익절 등)이 도움이 될 것 같으면 사이트의 규칙 메뉴에서 걸 수 있다고 알려 준다.
- 너는 면허 있는 투자 자문가가 아니다. 큰 결정 앞에서는 그 점을 한 번만 짧게 말한다 (매번 반복하지 않는다)."""

REVIEW = "지금 포트폴리오를 위 관점에서 리뷰해 줘. 꼭 세 줄로, 줄마다 '- '로 시작하고, 각 줄은 한 문장. 첫 줄은 지금 상태, 둘째 줄은 아쉬운 점이나 위험, 셋째 줄은 앞으로 확인해 볼 것."

_client: anthropic.AsyncAnthropic | None = None
_count = {"day": "", "n": 0}


class Turn(BaseModel):
    role: str
    content: str


class ChatIn(BaseModel):
    investor: str = "buffett"
    review: bool = False  # True 면 세 줄 리뷰 (messages 무시)
    messages: list[Turn] = []


def claude_bin() -> str:
    return config.CLAUDE_BIN or shutil.which("claude") or ""


def backend() -> str:
    if claude_bin():
        return "claude-code"
    return "api" if config.ANTHROPIC_API_KEY else ""


def configured() -> bool:
    return bool(backend())


def client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic(api_key=config.ANTHROPIC_API_KEY, timeout=120.0)
    return _client


def _won(v: float) -> str:
    return f"{round(v):,}원"


def context(port: dict | None, rules_text: list[str]) -> str:
    """AI 에게 보낼 포트폴리오 요약 (읽기 전용 숫자만)"""
    now = datetime.now(market.KST).strftime("%Y-%m-%d %H:%M")
    k = market.indices.get("kospi") or {}
    lines = [f"[데이터 시각] {now} (한국 시간), 장 {'열림' if market.market_open() else '닫힘'}"]
    if k.get("value") and k.get("prev"):
        lines.append(f"[코스피] {k['value']:,.2f} (전일 대비 {(k['value'] - k['prev']) / k['prev'] * 100:+.2f}%)")
    if not port:
        lines.append("[포트폴리오] 아직 불러오지 못함")
        return "\n".join(lines)
    hs = port["holdings"]
    invest = sum(h["qty"] * h["price"] for h in hs)
    cost = sum(h["qty"] * h["avg"] for h in hs)
    total = invest + port["cash"]
    lines.append(f"[총자산] {_won(total)} = 투자 {_won(invest)} + 현금 {_won(port['cash'])} (현금 {port['cash'] / total * 100 if total else 0:.1f}%)")
    lines.append(f"[평가손익] {_won(invest - cost)} ({(invest - cost) / cost * 100 if cost else 0:+.2f}%), 실현손익 {_won(port.get('realized', 0))}, 배당·이자 {_won(port.get('dividends', 0))}")
    lines.append("[계좌] " + ", ".join(a["name"] + (" (API 연동)" if a.get("linked") else " (수기)") for a in port.get("accounts", [])))
    lines.append("[보유 종목] 이름 | 종류·업종 | 수량 | 평균단가 | 현재가 | 수익률 | 오늘 | 평가금액 | 총자산 중 | 계좌")
    kinds = {"kr": "국내주식", "us": "해외주식", "coin": "코인", "gold": "금현물", "etc": "기타"}
    sectors: dict[str, float] = {}
    for h in sorted(hs, key=lambda x: -x["qty"] * x["price"]):
        amt = h["qty"] * h["price"]
        sectors[h.get("sector") or "기타"] = sectors.get(h.get("sector") or "기타", 0) + amt
        prof = (h["price"] - h["avg"]) / h["avg"] * 100 if h["avg"] else 0
        today = (h["price"] - h["prev"]) / h["prev"] * 100 if h.get("prev") else 0
        accts = ", ".join(f"{a['name']} {a['qty']:g}" for a in h.get("accounts", []))
        lines.append(f"- {h.get('name', h['code'])} | {kinds.get(h.get('asset', 'kr'), '')}·{h.get('sector', '')} | {h['qty']:g} | {_won(h['avg'])} | {_won(h['price'])} | {prof:+.1f}% | {today:+.2f}% | {_won(amt)} | {amt / total * 100 if total else 0:.1f}% | {accts}")
    if sectors:
        lines.append("[업종·종류 비중] " + ", ".join(f"{k2} {v / total * 100:.1f}%" for k2, v in sorted(sectors.items(), key=lambda x: -x[1])))
    lines.append("[걸어 둔 규칙] " + ("; ".join(rules_text) if rules_text else "없음"))
    from . import alerts  # alerts 가 ai 를 부르므로 늦게

    recent = alerts.for_ai()
    lines.append("[최근 24시간 알림 (급등락·거래량·뉴스 제목·공시·규칙)]" + ("\n" + "\n".join("- " + x for x in recent) if recent else " 없음"))
    lines.append("(해외주식·코인·금은 원화로 바꾼 값. 해외 평단은 지금 환율로 환산)")
    return "\n".join(lines)


def _check(b: ChatIn) -> list[dict]:
    if b.investor not in INVESTORS:
        raise HTTPException(400, "관점이 잘못됐습니다")
    if b.review:
        return [{"role": "user", "content": REVIEW}]
    msgs = [m for m in b.messages if m.content.strip()][-12:]  # 최근 대화만
    if not msgs or msgs[-1].role != "user":
        raise HTTPException(400, "질문을 넣어 주세요")
    out = []
    for m in msgs:
        if m.role not in ("user", "assistant") or len(m.content) > 2000:
            raise HTTPException(400, "대화 형식이 잘못됐습니다")
        if out and out[-1]["role"] == m.role:
            out[-1]["content"] += "\n" + m.content
        else:
            out.append({"role": m.role, "content": m.content})
    while out and out[0]["role"] != "user":
        out.pop(0)
    return out


def _count_one() -> None:
    day = datetime.now(market.KST).strftime("%Y-%m-%d")
    if _count["day"] != day:
        _count.update(day=day, n=0)
    if _count["n"] >= config.AI_DAILY_LIMIT:
        raise HTTPException(429, f"오늘 AI 사용 {config.AI_DAILY_LIMIT}번을 다 썼습니다 (backend/.env 의 AI_DAILY_LIMIT)")
    _count["n"] += 1


async def answer(b: ChatIn, ctx: str) -> AsyncIterator[str]:
    """글자가 생기는 대로 내보낸다 (화면에 바로 찍힘)"""
    msgs = _check(b)
    _count_one()
    system = [
        {"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": f"[사용자가 고른 관점] {INVESTORS[b.investor]}\n\n[사용자 포트폴리오]\n{ctx}"},
    ]

    if backend() == "claude-code":
        return _claude_code(system[0]["text"] + "\n\n" + system[1]["text"], msgs)

    async def gen() -> AsyncIterator[str]:
        try:
            async with client().beta.messages.stream(
                model=config.AI_MODEL,
                max_tokens=4000,
                output_config={"effort": "medium"},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",  # 거절되면 서버가 다른 모델로 이어 받음
                system=system,
                messages=msgs,
            ) as stream:
                async for text in stream.text_stream:
                    yield text
                final = await stream.get_final_message()
                if final.stop_reason == "refusal":
                    yield "\n\n(이 질문에는 답할 수 없다고 했습니다. 다르게 물어봐 주세요.)"
                elif final.stop_reason == "max_tokens":
                    yield "\n\n(답이 길어 중간에 끊겼습니다.)"
        except anthropic.AuthenticationError:
            yield "\n[AI 키가 맞지 않습니다. backend/.env 의 ANTHROPIC_API_KEY 를 확인해 주세요]"
        except anthropic.RateLimitError:
            yield "\n[AI 사용량 한도에 걸렸습니다. 잠시 뒤 다시 해 주세요]"
        except anthropic.APIStatusError as e:
            yield f"\n[AI 서버 오류 {e.status_code}: {e.message}]"
        except anthropic.APIConnectionError:
            yield "\n[AI 서버에 연결하지 못했습니다]"

    return gen()


# ---------- Claude Code (claude -p) ----------
def _prompt(msgs: list[dict]) -> str:
    """대화를 한 덩어리 글로 (claude -p 는 질문 하나를 받는다)"""
    if len(msgs) == 1:
        return msgs[0]["content"]
    past = "\n".join(("사용자: " if m["role"] == "user" else "AI: ") + m["content"] for m in msgs[:-1])
    return f"[지금까지 대화]\n{past}\n\n[지금 질문]\n{msgs[-1]['content']}"


async def _claude_code(system: str, msgs: list[dict]) -> AsyncIterator[str]:
    work = config.DATA / "ai-work"  # 빈 폴더에서 돌린다 (프로젝트 파일·설정을 읽지 않게)
    work.mkdir(exist_ok=True)
    env = {**os.environ, "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1"}
    if config.CLAUDE_CODE_OAUTH_TOKEN:
        # 서버: 구독 토큰으로 인증하고, 설정 파일은 앱이 쓸 수 있는 data/ 안에 둔다
        env["CLAUDE_CODE_OAUTH_TOKEN"] = config.CLAUDE_CODE_OAUTH_TOKEN
        env["CLAUDE_CONFIG_DIR"] = str(config.DATA / "claude")
    args = [
        claude_bin(), "-p",
        "--output-format", "stream-json", "--include-partial-messages", "--verbose",
        "--tools", "",  # 도구 없음: 파일·명령·주문 아무것도 못 한다
        "--strict-mcp-config", "--no-session-persistence", "--setting-sources", "",
        "--model", config.AI_MODEL,
        "--system-prompt", system,
    ]
    proc = await asyncio.create_subprocess_exec(*args, cwd=str(work), env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=2**22)
    proc.stdin.write(_prompt(msgs).encode())
    await proc.stdin.drain()
    proc.stdin.close()
    got = False
    try:
        while True:
            try:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=180)
            except asyncio.TimeoutError:
                yield "\n[AI 답이 너무 오래 걸려 멈췄습니다]"
                break
            if not line:
                break
            try:
                d = json.loads(line)
            except ValueError:
                continue
            t = d.get("type")
            ev = d.get("event") or {}
            if t == "stream_event" and ev.get("type") == "content_block_delta" and (ev.get("delta") or {}).get("type") == "text_delta":
                got = True
                yield ev["delta"]["text"]
            elif t == "result":
                if d.get("is_error") or d.get("subtype") != "success":
                    msg = str(d.get("result") or d.get("subtype") or "")
                    if "login" in msg.lower() or "auth" in msg.lower() or "token" in msg.lower():
                        yield "\n[Claude Code 로그인이 필요합니다. backend/.env 의 CLAUDE_CODE_OAUTH_TOKEN 을 확인해 주세요]"
                    else:
                        yield f"\n[AI 오류: {msg[:200]}]"
                elif not got and d.get("result"):
                    yield d["result"]  # 조각이 안 왔으면 최종 글로
        if proc.returncode is None:
            await asyncio.wait_for(proc.wait(), timeout=10)
        if proc.returncode and not got:
            err = (await proc.stderr.read()).decode(errors="replace")[-300:]
            yield f"\n[Claude Code 실행 실패: {err.strip() or proc.returncode}]"
    finally:
        if proc.returncode is None:
            proc.kill()


# ---------- 알림 요약 (alerts 가 사건이 있을 때만 부른다) ----------
BRIEF = """방금 아래 알림이 생겼다. 위 포트폴리오 숫자를 근거로 꼭 세 줄로 답해라. 줄마다 '- '로 시작, 한 줄은 한 문장.
1) 무슨 일인지 (알림에 있는 사실만. 뉴스는 제목만 있으니 본문을 지어내지 말 것)
2) 내 포트폴리오에 주는 영향 (그 종목 비중, 오늘 손익 같은 숫자로)
3) 지금 확인해 볼 것 (사라·팔라는 말 없이)

[알림]
"""


async def brief(events: list[str], ctx: str) -> str:
    """알림 묶음을 세 줄로. 하루 한도(AI_DAILY_LIMIT)에 같이 센다"""
    _count_one()
    system = SYSTEM + "\n\n[사용자 포트폴리오]\n" + ctx
    msgs = [{"role": "user", "content": BRIEF + "\n".join(events)}]
    if backend() == "claude-code":
        out = []
        async for t in _claude_code(system, msgs):
            out.append(t)
        return "".join(out)
    r = await client().messages.create(model=config.AI_MODEL, max_tokens=800, system=system, messages=msgs)
    return "".join(b.text for b in r.content if b.type == "text")
