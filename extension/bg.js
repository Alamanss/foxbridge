'use strict';
/* FoxBridge — фоновый скрипт.
 * Выключен по умолчанию. Включённый держит одно WebSocket-соединение с локальным
 * MCP-сервером (127.0.0.1) и выполняет его команды в отдельном окне Firefox. */

const PORT = 47615;
const VERSION = browser.runtime.getManifest().version;

let enabled = false;
let ws = null;
let retryTimer = null;
let retryDelay = 1000;
let lastTab = null;     // последняя вкладка, с которой работал Claude
const loginNotified = new Map(); // host -> время уведомления

/* ---------------- значок и состояние ---------------- */

function paint(state) {
  const map = {
    off:  ['icons/off.svg', '', 'FoxBridge выключен — нажмите, чтобы включить'],
    wait: ['icons/on.svg', '…', 'FoxBridge включён, ждёт Claude Code (сервер не запущен)'],
    on:   ['icons/on.svg', 'ON', 'FoxBridge: Claude Code подключён и может работать в Firefox. Нажмите, чтобы выключить'],
  };
  const [icon, badge, title] = map[state];
  browser.browserAction.setIcon({ path: icon });
  browser.browserAction.setBadgeText({ text: badge });
  browser.browserAction.setBadgeBackgroundColor({ color: state === 'on' ? '#2f9e44' : '#a16207' });
  browser.browserAction.setTitle({ title });
}

function setEnabled(on) {
  enabled = on;
  browser.storage.local.set({ enabled: on }).catch(() => {});
  clearTimeout(retryTimer);
  if (on) {
    retryDelay = 1000;
    paint('wait');
    connect();
  } else {
    if (ws) { try { ws.close(); } catch {} }
    ws = null;
    paint('off');
  }
}

browser.browserAction.onClicked.addListener(() => setEnabled(!enabled));
paint('off');
// Помним выбор пользователя: если оставил включённым — после перезапуска Firefox сразу подключаемся
browser.storage.local.get('enabled').then((s) => { if (s.enabled) setEnabled(true); }).catch(() => {});

/* ---------------- связь с сервером ---------------- */

function connect() {
  if (!enabled) return;
  let sock;
  try { sock = new WebSocket(`ws://127.0.0.1:${PORT}`); } catch { return scheduleRetry(); }
  ws = sock;
  sock.onopen = () => {
    retryDelay = 1000;
    paint('on');
    sock.send(JSON.stringify({ type: 'hello', version: VERSION }));
  };
  sock.onmessage = (ev) => onCommand(sock, ev.data);
  sock.onclose = () => {
    if (ws === sock) ws = null;
    if (enabled) { paint('wait'); scheduleRetry(); }
  };
  sock.onerror = () => {};
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryDelay);
  retryDelay = Math.min(retryDelay * 1.5, 5000);
}

async function onCommand(sock, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || msg.id == null) return;
  let reply;
  try {
    const result = await run(msg.cmd, msg.args || {});
    reply = { id: msg.id, ok: true, result };
  } catch (e) {
    reply = { id: msg.id, ok: false, error: String(e && e.message || e) };
  }
  if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply));
}

/* ---------------- окно Claude: живёт позади окна пользователя ----------------
 * Все вкладки Claude открываются в отдельном окне с подписью «Claude · …».
 * Окно создаётся один раз, после чего фокус сразу возвращается пользователю:
 * он смотрит своё (хоть YouTube), а заглянуть к Claude может через Alt+Tab. */

let claudeWin = null;
let freshTab = null; // пустая вкладка, с которой создаётся окно, — её занимает первый tab_new

browser.tabs.onRemoved.addListener((id) => {
  if (id === lastTab) lastTab = null;
  if (id === freshTab) freshTab = null;
});
browser.windows.onRemoved.addListener((id) => { if (id === claudeWin) { claudeWin = null; lastTab = null; freshTab = null; } });

async function currentWindowId() {
  const w = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
  return w.id;
}

async function ensureWindow() {
  if (claudeWin != null) {
    try { await browser.windows.get(claudeWin); return claudeWin; } catch { claudeWin = null; }
  }
  let userWin = null;
  try { userWin = await browser.windows.getLastFocused({ windowTypes: ['normal'] }); } catch {}
  const w = await browser.windows.create({ url: 'about:blank', titlePreface: 'Claude · ', width: 1280, height: 860 });
  claudeWin = w.id;
  freshTab = w.tabs[0].id;
  // Вернуть пользователю его окно — Claude работает позади
  if (userWin) await browser.windows.update(userWin.id, { focused: true }).catch(() => {});
  return claudeWin;
}

// Вкладка по умолчанию: последняя, с которой работал Claude, иначе активная вкладка окна Claude.
// Вкладки пользователя Claude трогает, только если ему явно передали их tabId.
async function ownTab(tabId) {
  if (tabId == null) {
    if (lastTab != null) {
      try { return await browser.tabs.get(lastTab); } catch { lastTab = null; }
    }
    const win = await ensureWindow();
    const [t] = await browser.tabs.query({ windowId: win, active: true });
    if (t.id === freshTab) freshTab = null;
    lastTab = t.id;
    return t;
  }
  let tab;
  try { tab = await browser.tabs.get(tabId); } catch { throw new Error(`Вкладка ${tabId} закрыта.`); }
  lastTab = tabId;
  return tab;
}

function tabInfo(t) {
  return { tabId: t.id, url: t.url, title: t.title, active: t.active, loading: t.status === 'loading', claude: t.windowId === claudeWin };
}

function waitLoaded(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(onUpd);
      clearTimeout(timer);
      resolve();
    };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    const timer = setTimeout(finish, timeout);
    browser.tabs.onUpdated.addListener(onUpd);
    browser.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(); }).catch(finish);
  });
}

// Переход начинается не мгновенно (особенно в фоновом окне): сперва ждём, что он начался,
// и только потом — окончания загрузки. Иначе можно прочитать ещё старую страницу.
async function waitNavigated(tabId, oldUrl) {
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    const now = await browser.tabs.get(tabId);
    if (now.status === 'loading' || now.url !== oldUrl) break;
  }
  await waitLoaded(tabId);
}

// После клика/клавиши: если страница начала грузиться — дождаться загрузки.
async function settle(tabId) {
  await sleep(250);
  try {
    const t = await browser.tabs.get(tabId);
    if (t.status === 'loading') await waitLoaded(tabId, 12000);
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- контент-скрипт ---------------- */

async function page(tabId, cmd, args) {
  await browser.tabs.executeScript(tabId, { file: 'content.js', runAt: 'document_idle' }).catch((e) => {
    throw new Error('Эта страница закрыта для расширений (служебные страницы Firefox, просмотр JSON/PDF, addons.mozilla.org). Используй screenshot или открой другую страницу. Подробно: ' + e.message);
  });
  return browser.tabs.sendMessage(tabId, { cmd, args });
}

function noteLogin(res, url) {
  if (!res || !res.login) return res;
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  const now = Date.now();
  if (!loginNotified.get(host) || now - loginNotified.get(host) > 120000) {
    loginNotified.set(host, now);
    browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/on.svg'),
      title: 'FoxBridge: нужен ваш вход',
      message: `Нужен вход на ${host}. Войдите в окне «Claude ·» (автозаполнение подойдёт) и скажите ему, что готово.`,
    });
  }
  return res;
}

/* ---------------- команды ---------------- */

async function run(cmd, a) {
  switch (cmd) {
    case 'status': {
      const tabs = claudeWin != null ? await browser.tabs.query({ windowId: claudeWin }) : [];
      return { version: VERSION, claudeWindow: claudeWin, tabs: tabs.map(tabInfo) };
    }

    case 'tabs_list': {
      if (a.all) return (await browser.tabs.query({})).map(tabInfo);
      if (claudeWin == null) return [];
      return (await browser.tabs.query({ windowId: claudeWin })).map(tabInfo);
    }

    case 'tab_new': {
      const url = a.url ? (/^[a-z][a-z0-9+.-]*:/i.test(a.url) ? a.url : 'https://' + a.url) : undefined;
      const win = await ensureWindow();
      let id;
      if (freshTab != null) {
        id = freshTab;
        freshTab = null;
        if (url) await browser.tabs.update(id, { url });
      } else {
        // Активна внутри окна Claude — окно пользователя это не затрагивает
        id = (await browser.tabs.create({ windowId: win, url, active: true })).id;
      }
      lastTab = id;
      if (url) await waitNavigated(id, 'about:blank');
      return tabInfo(await browser.tabs.get(id));
    }

    case 'tab_select': {
      const t = await ownTab(a.tabId);
      await browser.tabs.update(t.id, { active: true });
      return tabInfo(await browser.tabs.get(t.id));
    }

    case 'tab_close': {
      const t = await ownTab(a.tabId);
      await browser.tabs.remove(t.id);
      return { closed: t.id };
    }

    case 'navigate': {
      const t = await ownTab(a.tabId);
      const url = String(a.url || '');
      if (url === 'back') await browser.tabs.goBack(t.id);
      else if (url === 'forward') await browser.tabs.goForward(t.id);
      else if (url === 'reload') await browser.tabs.reload(t.id);
      else {
        const full = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url;
        await browser.tabs.update(t.id, { url: full });
      }
      await waitNavigated(t.id, t.url);
      const info = tabInfo(await browser.tabs.get(t.id));
      try {
        const probe = await page(t.id, 'probe', {});
        noteLogin(probe, info.url);
        info.login = !!probe.login;
      } catch {}
      return info;
    }

    case 'screenshot': {
      const t = await ownTab(a.tabId);
      // Фоновую вкладку на мгновение показываем ради снимка и сразу возвращаем вкладку пользователя
      let back = null;
      if (!t.active) {
        [back] = await browser.tabs.query({ windowId: t.windowId, active: true });
        await browser.tabs.update(t.id, { active: true });
        await sleep(180);
      }
      let vp = { w: 0, h: 0, dpr: 1 };
      let data;
      try {
        try { vp = await page(t.id, 'viewport', {}); } catch {}
        // Снимок в CSS-пикселях: координаты на картинке = координаты для click(x, y)
        const scale = Math.min(1 / (vp.dpr || 1), 1);
        data = await browser.tabs.captureTab(t.id, { format: 'jpeg', quality: a.quality || 70, scale });
      } finally {
        if (back) await browser.tabs.update(back.id, { active: true }).catch(() => {});
      }
      return { data: data.replace(/^data:image\/jpeg;base64,/, ''), width: vp.w, height: vp.h, url: t.url, title: t.title };
    }

    case 'eval_js': {
      const t = await ownTab(a.tabId);
      const code = String(a.code || '');
      const wrap = (body) => `(async () => { ${body} })().then(v => { try { return JSON.stringify(v === undefined ? null : v); } catch (e) { return String(v); } })`;
      let res;
      try {
        res = await browser.tabs.executeScript(t.id, { code: wrap(`return (${code});`) });
      } catch (e) {
        if (!/SyntaxError/i.test(String(e))) throw e;
        res = await browser.tabs.executeScript(t.id, { code: wrap(code) });
      }
      return { value: res && res[0] };
    }

    case 'wait': {
      await sleep(Math.min(Number(a.seconds) || 1, 30) * 1000);
      return { waited: Number(a.seconds) || 1 };
    }

    // Всё остальное делается внутри страницы
    case 'read_page': case 'find': case 'get_text': case 'wait_for':
    case 'click': case 'type': case 'key': case 'scroll': case 'hover': case 'form_input': {
      const t = await ownTab(a.tabId);
      let res;
      try {
        res = await page(t.id, cmd, a);
      } catch (e) {
        // Страница ушла (переход по ссылке) раньше, чем ответила — это нормально.
        // Любую другую ошибку (например, запрет на ввод пароля) показываем как есть.
        const gone = /disconnected|Receiving end does not exist|Could not establish connection|unload|dead object/i.test(String(e && e.message));
        if (gone && ['click', 'key', 'type', 'form_input'].includes(cmd)) res = { note: 'Страница перезагрузилась после действия' };
        else throw e;
      }
      if (['click', 'key', 'type', 'form_input'].includes(cmd)) {
        await settle(t.id);
        const now = await browser.tabs.get(t.id);
        res = { ...res, url: now.url, title: now.title };
      }
      return noteLogin(res, t.url);
    }

    default:
      throw new Error('Неизвестная команда: ' + cmd);
  }
}
