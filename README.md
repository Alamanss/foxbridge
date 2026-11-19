# FoxBridge — Firefox for Claude Code

**English** · [Русский](#русский)

FoxBridge lets [Claude Code](https://claude.com/claude-code) work in your own Firefox: open tabs, read pages, click, type, scroll and take screenshots. It is a small Firefox extension plus a tiny local MCP server — no cloud, no accounts, no npm.

> Unofficial community project. Not affiliated with or endorsed by Anthropic or Mozilla.

```
Claude Code  ⇄  fox_mcp.py (MCP over stdio)  ⇄  WebSocket 127.0.0.1:47615  ⇄  FoxBridge extension
```

## Why

- **Fast.** Pages are read as compact text with `[ref_N]` labels, and Claude clicks by label instead of guessing pixels. Measured on a real machine: read a page 0.03–0.13 s, click / type ≈ 0.3 s, screenshot 0.04–0.1 s.
- **Few round trips.** `batch` runs several actions in one call.
- **Light.** One persistent background script with a single local socket. Turned off, it does nothing.
- **Stays out of your way.** Claude works in its own Firefox window titled *Claude · …*, created behind yours. Keep watching a video; Alt+Tab to peek or to help.
- **Screenshots in CSS pixels.** A point on the screenshot is exactly the `x, y` for `click`.

## Safety

- Talks only to `127.0.0.1`. The server accepts connections only from a `moz-extension://` origin and remembers the first extension that connected.
- **Never types passwords or one-time codes** — this is enforced in the extension code. When a page has a login form, the tool result says `login=true` and you get a Firefox notification asking *you* to sign in.
- Off by default. Click the toolbar icon to turn it on (badge **ON**); the choice is remembered across restarts. Click again to turn it off.

## Install

**1. Server** (Python 3.10+):

```bash
pip install websockets
claude mcp add --scope user firefox -- python -I /path/to/foxbridge/server/fox_mcp.py
```

**2. Extension.** Until it is listed on addons.mozilla.org:

- *Try it:* open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `extension/manifest.json` (removed when Firefox restarts).
- *Keep it:* run `python build.py`, upload `dist/foxbridge-<version>.zip` to [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) as **On your own** (unlisted, free, automatic signing), then drag the signed `.xpi` into Firefox.

**3.** Click the FoxBridge icon so it shows **ON**, then ask Claude Code to do something in Firefox.

## Tools

| Tool | What it does |
|---|---|
| `status`, `tabs_list` | Connection check, tabs of the current window (`all` for every window) |
| `tab_new`, `tab_select`, `tab_close` | Manage Claude's tabs (they live in the Claude window) |
| `navigate` | Go to a URL (or `back` / `forward` / `reload`) and wait for load |
| `read_page`, `find`, `get_text` | Page as text with `[ref_N]`; search; main text |
| `click`, `type`, `key`, `scroll`, `hover`, `form_input` | Actions by ref or by screenshot coordinates |
| `screenshot` | JPEG of the visible part of the tab |
| `wait_for`, `wait` | Wait for text to appear/disappear, or for N seconds |
| `eval_js` | Run JavaScript on the page (debugging) |
| `batch` | Several of the above in one call |

## Limitations

- Events are synthetic (`isTrusted = false`). Almost all sites accept them; a few that check for real user input may not.
- Firefox does not let extensions into its own pages (`about:*`, JSON/PDF viewers, addons.mozilla.org). Use `screenshot` there.
- One Claude Code session controls Firefox at a time (the port is shared).

## Development

```bash
python -I server/test_live.py   # live end-to-end test against a running Firefox
python build.py                 # pack the extension for signing
```

License: MIT.

---

## Русский

FoxBridge даёт [Claude Code](https://claude.com/claude-code) работать в вашем Firefox: открывать вкладки, читать страницы, нажимать, вводить текст, прокручивать и делать скриншоты. Это маленькое расширение Firefox и крошечный локальный MCP-сервер. Без облака, аккаунтов и npm.

> Неофициальный проект. Не связан с Anthropic и Mozilla.

**Не мешает.** Claude работает в своём окне Firefox «Claude · …», которое открывается позади вашего. Смотрите своё, заглянуть можно через Alt+Tab.

**Почему быстро.** Страница читается коротким текстом с метками `[ref_N]`, Claude нажимает по метке, а не угадывает пиксели. Замеры на живом ПК: чтение страницы 0,03–0,13 с, клик и ввод ≈ 0,3 с, скриншот 0,04–0,1 с. Несколько действий можно отправить одним вызовом `batch`.

**Безопасность.**
- Связь только с `127.0.0.1`, сервер пускает только расширение Firefox.
- **Пароли и одноразовые коды не вводятся никогда** — это зашито в код расширения. Если на странице форма входа, Claude получает `login=true`, а вам приходит уведомление Firefox с просьбой войти самому.
- По умолчанию выключено. Значок на панели включает (**ON**) и выключает; выбор запоминается.

**Установка.**
1. Сервер: `pip install websockets`, затем
   `claude mcp add --scope user firefox -- python -I путь/к/foxbridge/server/fox_mcp.py`.
2. Расширение: для пробы — `about:debugging#/runtime/this-firefox` → «Загрузить временное дополнение…» → `extension/manifest.json`. Насовсем — `python build.py`, загрузить `dist/foxbridge-<версия>.zip` на [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) как «On your own» (бесплатно, подпись автоматическая) и перетащить подписанный `.xpi` в Firefox.
3. Нажать значок FoxBridge, чтобы горел **ON**, и попросить Claude Code сделать что-нибудь в Firefox.

**Ограничения.** События синтетические — почти все сайты их принимают, но редкие, которые проверяют «настоящий» ввод, могут нет. В служебные страницы Firefox (`about:*`, просмотр JSON/PDF, addons.mozilla.org) расширения не пускают — там поможет `screenshot`. Одновременно Firefox управляет одна сессия Claude Code.

Лицензия: MIT.
