"""Живой тест: поднимает мост, ждёт расширение и прогоняет сценарий. Запуск: python -I test_live.py"""
import asyncio
import base64
import sys
import time
from pathlib import Path

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fox_mcp as fx  # noqa: E402

OUT = Path(__file__).resolve().parent / "test-out"
MANIFEST = Path(__file__).resolve().parent.parent / "extension" / "manifest.json"
WANT = __import__("json").loads(MANIFEST.read_text(encoding="utf-8"))["version"]


async def step(name, args=None):
    t = time.perf_counter()
    try:
        blocks = await fx.run_tool(name, args or {})
    except Exception as e:  # noqa: BLE001
        print(f"✗ {name} {args or ''} — {e}  ({time.perf_counter() - t:.2f}s)", flush=True)
        return None
    dt = time.perf_counter() - t
    for b in blocks:
        if b["type"] == "image":
            OUT.mkdir(exist_ok=True)
            p = OUT / f"shot-{int(time.time() * 1000)}.jpg"
            p.write_bytes(base64.b64decode(b["data"]))
            print(f"✓ {name} → {p.name} ({dt:.2f}s)", flush=True)
        else:
            text = b["text"]
            short = text if len(text) < 700 else text[:700] + f"… [+{len(text) - 700}]"
            print(f"✓ {name} ({dt:.2f}s)\n{short}\n", flush=True)
    return blocks


def ref_of(blocks, needle):
    for line in blocks[0]["text"].splitlines():
        if needle.lower() in line.lower() and "[ref_" in line:
            return line.split("[")[1].split("]")[0]
    return None


async def scenario():
    global TAB
    await step("status")
    new = await step("tab_new", {"url": "https://httpbin.org/forms/post"})
    TAB = __import__("json").loads(new[0]["text"])["tabId"]
    page = await step("read_page")
    name = ref_of(page, 'textbox "Customer name')
    await step("type", {"ref": name, "text": "Тест Claude"})
    await step("form_input", {"ref": ref_of(page, 'radio "Large'), "value": True})
    await step("form_input", {"ref": ref_of(page, 'checkbox "Bacon'), "value": True})
    await step("screenshot")
    await step("click", {"ref": ref_of(page, 'button "Submit order')})
    await step("get_text", {"max_chars": 600})
    await step("batch", {"actions": [
        {"tool": "navigate", "args": {"url": "https://ru.wikipedia.org/wiki/Firefox"}},
        {"tool": "find", "args": {"query": "Mozilla Foundation"}},
        {"tool": "scroll", "args": {"direction": "down", "amount": 5}},
    ]})
    wiki = await step("read_page", {"max_chars": 1500})
    search = ref_of(wiki, "searchbox")
    if search:
        await step("type", {"ref": search, "text": "Казахстан", "submit": True})
        await step("wait_for", {"text": "Казахстан", "timeout": 10})
    await step("screenshot")
    await step("eval_js", {"code": "document.title + ' | ' + location.host"})
    gh = await step("navigate", {"url": "https://github.com/login"})
    login = await step("read_page")
    pw = ref_of(login, "password")
    await step("type", {"ref": pw, "text": "should-be-blocked"})
    await step("status")
    await step("tab_close", {"tabId": TAB})


async def main():
    server = await websockets.serve(fx.bridge.handler, "127.0.0.1", fx.PORT, max_size=32 * 1024 * 1024)
    print("Жду расширение (нажмите значок FoxBridge в Firefox)…", flush=True)
    try:
        await asyncio.wait_for(fx.bridge.connected.wait(), 900)
    except asyncio.TimeoutError:
        print("Не дождался подключения за 15 минут.")
        return
    # Не запускаться на старой версии расширения: ждём, пока пользователь его перезагрузит
    while True:
        st = await fx.bridge.call("status", {})
        if st.get("version") == WANT:
            break
        print(f"Подключилась старая версия {st.get('version')}, жду {WANT}…", flush=True)
        await asyncio.sleep(3)
    print("Подключено\n", flush=True)
    await scenario()
    server.close()
    print("ГОТОВО", flush=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main())
