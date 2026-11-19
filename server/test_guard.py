"""Короткий тест: ввод пароля должен вернуть честную ошибку."""
import asyncio
import sys
from pathlib import Path

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fox_mcp as fx  # noqa: E402


async def main():
    server = await websockets.serve(fx.bridge.handler, "127.0.0.1", fx.PORT)
    await asyncio.wait_for(fx.bridge.connected.wait(), 900)
    await fx.run_tool("navigate", {"url": "https://github.com/login"})
    page = (await fx.run_tool("read_page", {}))[0]["text"]
    pw = next(l for l in page.splitlines() if l.startswith("password")).split("[")[1].split("]")[0]
    try:
        await fx.run_tool("type", {"ref": pw, "text": "should-be-blocked"})
        print("ПЛОХО: ввод прошёл")
    except Exception as e:  # noqa: BLE001
        print("OK, заблокировано:", e)
    v = (await fx.run_tool("eval_js", {"code": "document.querySelector('input[type=password]').value.length"}))[0]["text"]
    print("длина пароля в поле:", v)
    server.close()


sys.stdout.reconfigure(encoding="utf-8")
asyncio.run(main())
