"""한투 연결 점검: .venv\\Scripts\\python -m app.selfcheck
키·토큰 값은 출력하지 않는다. 주문은 하지 않는다."""

import asyncio
import time

from . import config, market
from .kis import KISError, kis


async def step(name: str, coro):
    t = time.time()
    try:
        r = await coro
        print(f"[OK]   {name} ({time.time() - t:.1f}s) {r if r is not None else ''}")
        return True
    except KISError as e:
        print(f"[FAIL] {name}: {e} {('(' + e.code + ')') if e.code else ''}")
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] {name}: {e.__class__.__name__}: {e}")
    return False


async def main() -> None:
    print("모드", config.KIS_MODE, "| 초당 호출", config.KIS_RPS)

    async def tok():
        await kis.token()
        return "토큰 받음 (파일에 저장)"

    async def idx():
        await market.fetch_index("kospi", "0001", "코스피")
        i = market.indices["kospi"]
        return f"코스피 {i['value']:.2f} (전일 {i['prev']:.2f})"

    async def quote():
        q = await market.fetch_quote("005930")
        return f"삼성전자 {q['price']:,} 전일 {q['prev']:,} 시총 {q['cap']:.1f}조 PER {q['per']} 상한 {q['upper']:,}"

    async def book():
        b = await market.fetch_book("005930")
        return f"매도 {len(b['asks'])}단계 매수 {len(b['bids'])}단계, 최우선 매수 {b['bids'][0]['p'] if b['bids'] else '-'}"

    async def daily():
        c = await market.fetch_candles("005930", "D")
        return f"일봉 {len(c)}개 ({c[0]['t'] if c else '-'} ~ {c[-1]['t'] if c else '-'})"

    async def bal():
        b = await market.fetch_balance()
        return f"보유 {len(b['holdings'])}종목, 예수금 {b['cash']:,}원"

    async def psbl():
        return f"주문가능현금 {await market.fetch_buyable('005930', market.quotes.get('005930', {}).get('price', 70000), False):,}원"

    ok = await step("토큰", tok())
    if not ok:
        return
    for name, fn in [("지수", idx), ("현재가", quote), ("호가", book), ("일봉", daily), ("잔고", bal), ("매수가능", psbl)]:
        await step(name, fn())
    if kis.last_error:
        print("마지막 오류:", kis.last_error)
    await kis.close()


if __name__ == "__main__":
    asyncio.run(main())
