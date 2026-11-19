"""FoxBridge — MCP-сервер (stdio) + WebSocket-мост к расширению Firefox.

Claude Code запускает этот файл сам. Сервер слушает только 127.0.0.1:47615 и принимает
соединение только от расширения Firefox (Origin moz-extension://…). Первое расширение,
которое подключилось, запоминается, остальные отклоняются.

Зависимость: websockets.
"""
import asyncio
import itertools
import json
import os
import sys
import threading
from pathlib import Path

import websockets

PORT = 47615
VERSION = "1.0.0"
PROTOCOL = "2025-06-18"
CONF = Path(os.environ.get("APPDATA", Path.home())) / "foxbridge" / "config.json"

INSTRUCTIONS = (
    "Управление Firefox пользователя через расширение FoxBridge. "
    "Claude работает в своём окне Firefox («Claude · …»), которое стоит позади окна пользователя: пользователь занимается своим (хоть смотрит видео), а заглянуть может через Alt+Tab. Вкладки пользователя трогай, только когда он сам об этом просит (tabs_list all=true даёт их tabId). "
    "Порядок работы: navigate (или tab_new) → read_page/find (получить ref_N) → click/type по ref → "
    "screenshot только когда нужно увидеть вёрстку. Несколько шагов подряд — одним вызовом batch. "
    "Пароли и коды подтверждения вводит только пользователь: если результат содержит login=true, "
    "попроси его войти в окне «Claude ·» и дождись ответа. Если расширение не подключено — попроси "
    "пользователя нажать значок FoxBridge на панели Firefox."
)

# ---------------------------------------------------------------- инструменты

def S(props=None, required=None):
    return {"type": "object", "properties": props or {}, "required": required or []}

TAB = {"tabId": {"type": "integer", "description": "id вкладки; по умолчанию последняя вкладка Claude"}}
REF = {"ref": {"type": "string", "description": "ref_N из read_page/find"}}
XY = {"x": {"type": "number", "description": "X в пикселях скриншота"}, "y": {"type": "number", "description": "Y в пикселях скриншота"}}

TOOLS = [
    ("status", "Проверить связь с Firefox и показать вкладки окна Claude.", S()),
    ("tabs_list", "Вкладки окна Claude. all=true — все вкладки Firefox, включая пользовательские.",
     S({"all": {"type": "boolean"}})),
    ("tab_new", "Открыть вкладку в окне Claude (создаётся позади окна пользователя и не отнимает фокус); дальше она — вкладка по умолчанию.",
     S({"url": {"type": "string"}})),
    ("tab_select", "Сделать вкладку активной (переключиться на неё).", S(TAB, ["tabId"])),
    ("tab_close", "Закрыть вкладку.", S(TAB, ["tabId"])),
    ("navigate", "Перейти по адресу и дождаться загрузки. url может быть 'back', 'forward', 'reload'.",
     S({**TAB, "url": {"type": "string"}}, ["url"])),
    ("read_page", "Страница текстом: элементы с метками [ref_N]. filter: interactive (по умолчанию) | all (с текстом). ref_id — только часть страницы.",
     S({**TAB, "filter": {"type": "string", "enum": ["interactive", "all"]}, "ref_id": {"type": "string"},
        "max_chars": {"type": "integer"}})),
    ("find", "Найти на странице элементы и текст по подстроке, с ref.", S({**TAB, "query": {"type": "string"}}, ["query"])),
    ("get_text", "Основной текст страницы (main/article/body).", S({**TAB, "max_chars": {"type": "integer"}})),
    ("click", "Клик по ref или по координатам скриншота. button: left|right, double: двойной.",
     S({**TAB, **REF, **XY, "button": {"type": "string", "enum": ["left", "right"]}, "double": {"type": "boolean"}})),
    ("type", "Ввести текст в поле (ref) или в поле с фокусом. clear=false — дописать. submit=true — нажать Enter. Пароли запрещены.",
     S({**TAB, **REF, "text": {"type": "string"}, "clear": {"type": "boolean"}, "submit": {"type": "boolean"}}, ["text"])),
    ("key", "Нажать клавиши: 'Enter', 'Escape', 'Tab', 'ctrl+a', 'ArrowDown' (через пробел — по очереди).",
     S({**TAB, "keys": {"type": "string"}, "repeat": {"type": "integer"}}, ["keys"])),
    ("scroll", "Прокрутить: direction up|down|left|right, amount в шагах (≈120px). ref без direction — прокрутить к элементу.",
     S({**TAB, **REF, **XY, "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
        "amount": {"type": "number"}})),
    ("hover", "Навести курсор на элемент (ref или x, y).", S({**TAB, **REF, **XY})),
    ("form_input", "Задать значение: select (value или текст варианта), checkbox/radio (true/false), поле (текст).",
     S({**TAB, **REF, "value": {}}, ["ref", "value"])),
    ("screenshot", "Скриншот видимой части вкладки. Пиксели картинки = координаты для click(x, y).",
     S({**TAB, "quality": {"type": "integer", "description": "JPEG 30–95, по умолчанию 70"}})),
    ("wait_for", "Ждать, пока на странице появится текст (gone=true — пока исчезнет).",
     S({**TAB, "text": {"type": "string"}, "gone": {"type": "boolean"}, "timeout": {"type": "number"}}, ["text"])),
    ("wait", "Подождать N секунд (до 30).", S({"seconds": {"type": "number"}}, ["seconds"])),
    ("eval_js", "Выполнить JavaScript на странице (для отладки). Можно выражение или тело с return и await.",
     S({**TAB, "code": {"type": "string"}}, ["code"])),
    ("batch", "Несколько действий подряд за один вызов, остановка на первой ошибке. "
              "actions: [{\"tool\": \"click\", \"args\": {\"ref\": \"ref_3\"}}, …]",
     S({"actions": {"type": "array", "items": S({"tool": {"type": "string"}, "args": {"type": "object"}}, ["tool"])}},
       ["actions"])),
]
TOOL_NAMES = {t[0] for t in TOOLS}

# ---------------------------------------------------------------- мост к расширению

def log(text):
    """Журнал подключений в %APPDATA%\\foxbridge\\fox.log (stdout занят протоколом MCP)."""
    try:
        CONF.parent.mkdir(parents=True, exist_ok=True)
        with open(CONF.parent / "fox.log", "a", encoding="utf-8") as f:
            f.write(f"{__import__('time').strftime('%H:%M:%S')} {text}\n")
    except OSError:
        pass


class Bridge:
    def __init__(self):
        self.sock = None
        self.pending = {}
        self.ids = itertools.count(1)
        self.connected = asyncio.Event()
        self.pinned = self._load_pin()
        self.bind_error = None

    @staticmethod
    def _load_pin():
        try:
            return json.loads(CONF.read_text(encoding="utf-8")).get("origin")
        except Exception:
            return None

    def _save_pin(self, origin):
        CONF.parent.mkdir(parents=True, exist_ok=True)
        CONF.write_text(json.dumps({"origin": origin}), encoding="utf-8")
        self.pinned = origin

    async def handler(self, ws):
        origin = ws.request.headers.get("Origin", "") if ws.request else ""
        log(f"connect origin={origin!r} pinned={self.pinned!r}")
        if not origin.startswith("moz-extension://"):
            await ws.close(4003, "only the Firefox extension may connect")
            return
        if self.pinned and origin != self.pinned:
            # Расширение переустановили — у него новый адрес. Принимаем, только если старое не на связи.
            if self.sock is not None:
                await ws.close(4003, "another extension is connected")
                return
        if origin != self.pinned:
            self._save_pin(origin)
        if self.sock is not None:
            try:
                await self.sock.close(4000, "replaced")
            except Exception:
                pass
        self.sock = ws
        self.connected.set()
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                fut = self.pending.pop(msg.get("id"), None)
                if fut and not fut.done():
                    fut.set_result(msg)
        finally:
            if self.sock is ws:
                self.sock = None
                self.connected.clear()
                for fut in self.pending.values():
                    if not fut.done():
                        fut.set_exception(RuntimeError("Firefox отключился посреди команды."))
                self.pending.clear()

    async def call(self, cmd, args, timeout=60):
        if self.bind_error:
            raise RuntimeError(self.bind_error)
        if self.sock is None:
            try:
                await asyncio.wait_for(self.connected.wait(), 4)
            except asyncio.TimeoutError:
                raise RuntimeError(
                    "Firefox не подключён. Попроси пользователя нажать значок FoxBridge на панели Firefox "
                    "(серый = выключен, ON = подключён).")
        mid = next(self.ids)
        fut = asyncio.get_running_loop().create_future()
        self.pending[mid] = fut
        await self.sock.send(json.dumps({"id": mid, "cmd": cmd, "args": args}))
        try:
            msg = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            self.pending.pop(mid, None)
            raise RuntimeError(f"Firefox не ответил за {timeout} с.")
        if not msg.get("ok"):
            raise RuntimeError(msg.get("error") or "ошибка в Firefox")
        return msg.get("result")


bridge = Bridge()

# ---------------------------------------------------------------- выполнение инструментов

LOGIN_NOTE = ("\n⚠ На странице форма входа (login=true). Пароли и коды вводит только пользователь: "
              "попроси его войти в окне «Claude ·» (ему пришло уведомление) и дождись ответа.")


def as_text(result):
    if isinstance(result, dict) and isinstance(result.get("text"), str):
        rest = {k: v for k, v in result.items() if k not in ("text", "login")}
        txt = result["text"]
        if rest:
            txt += "\n" + json.dumps(rest, ensure_ascii=False)
        if result.get("login"):
            txt += LOGIN_NOTE
        return txt
    txt = json.dumps(result, ensure_ascii=False, indent=None)
    if isinstance(result, dict) and result.get("login"):
        txt += LOGIN_NOTE
    return txt


async def run_tool(name, args):
    """Возвращает список блоков content."""
    if name not in TOOL_NAMES:
        raise RuntimeError(f"Нет такого инструмента: {name}")
    if name == "batch":
        out = []
        for i, step in enumerate(args.get("actions") or [], 1):
            tool, targs = step.get("tool"), step.get("args") or {}
            if tool == "batch":
                raise RuntimeError("batch внутри batch нельзя")
            try:
                blocks = await run_tool(tool, targs)
            except Exception as e:  # noqa: BLE001
                out.append({"type": "text", "text": f"[{i}] {tool}: ОШИБКА — {e}. Остальные шаги не выполнены."})
                return out
            for b in blocks:
                if b["type"] == "text":
                    b = {"type": "text", "text": f"[{i}] {tool}: {b['text']}"}
                out.append(b)
        return out
    if name == "screenshot":
        r = await bridge.call("screenshot", args)
        return [
            {"type": "image", "data": r["data"], "mimeType": "image/jpeg"},
            {"type": "text", "text": f"{r.get('title')} — {r.get('url')}\nРазмер {r.get('width')}x{r.get('height')} "
                                     f"(пиксели = координаты для click)"},
        ]
    timeout = 90 if name in ("wait_for", "wait", "navigate", "tab_new") else 60
    r = await bridge.call(name, args, timeout=timeout)
    return [{"type": "text", "text": as_text(r)}]

# ---------------------------------------------------------------- MCP по stdio

def send(msg):
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def handle(msg):
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        ver = (msg.get("params") or {}).get("protocolVersion") or PROTOCOL
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": ver,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "foxbridge", "version": VERSION},
            "instructions": INSTRUCTIONS,
        }})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [
            {"name": n, "description": d, "inputSchema": s} for n, d, s in TOOLS]}})
    elif method == "tools/call":
        p = msg.get("params") or {}
        try:
            content = await run_tool(p.get("name"), p.get("arguments") or {})
            send({"jsonrpc": "2.0", "id": mid, "result": {"content": content, "isError": False}})
        except Exception as e:  # noqa: BLE001
            send({"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": str(e)}], "isError": True}})
    elif method == "ping":
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Method not found: {method}"}})
    # уведомления (без id) молча пропускаем


def stdin_reader(loop, queue):
    for line in sys.stdin:
        line = line.strip()
        if line:
            loop.call_soon_threadsafe(queue.put_nowait, line)
    loop.call_soon_threadsafe(queue.put_nowait, None)


async def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    loop = asyncio.get_running_loop()
    try:
        server = await websockets.serve(bridge.handler, "127.0.0.1", PORT, max_size=32 * 1024 * 1024)
    except OSError:
        server = None
        bridge.bind_error = (f"Порт {PORT} занят: Firefox сейчас управляет другая сессия Claude Code. "
                             "Закройте её или работайте там.")
    queue = asyncio.Queue()
    threading.Thread(target=stdin_reader, args=(loop, queue), daemon=True).start()
    tasks = set()
    while True:
        line = await queue.get()
        if line is None:
            break
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        t = asyncio.create_task(handle(msg))
        tasks.add(t)
        t.add_done_callback(tasks.discard)
    if server:
        server.close()


if __name__ == "__main__":
    asyncio.run(main())
