/* FoxBridge — работа внутри страницы. Внедряется один раз на страницу. */
if (!window.__claudeFx) {
  window.__claudeFx = true;

  const refs = new Map();       // 'ref_N' -> WeakRef(element)
  const ids = new WeakMap();    // element -> 'ref_N'
  let next = 1;

  const refOf = (el) => {
    let r = ids.get(el);
    if (!r) { r = 'ref_' + next++; ids.set(el, r); }
    refs.set(r, new WeakRef(el));
    return r;
  };
  const byRef = (r) => {
    const el = refs.get(r) && refs.get(r).deref();
    if (!el || !el.isConnected) throw new Error(`Элемент ${r} не найден — страница изменилась, перечитай её (read_page или find).`);
    return el;
  };

  const INTERACTIVE = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]', '[role=menuitem]',
    '[role=menuitemcheckbox]', '[role=option]', '[role=switch]', '[role=combobox]', '[role=textbox]',
    '[role=searchbox]', '[role=slider]', '[contenteditable=""]', '[contenteditable=true]', '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const clean = (s, n = 90) => {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };

  function visible(el) {
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox' || t === 'radio' || t === 'range' || t === 'file') return t === 'range' ? 'slider' : t;
      if (t === 'search') return 'searchbox';
      if (t === 'password') return 'password';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  }

  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.textContent).join(' ');
      if (t.trim()) return clean(t);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.labels && el.labels[0]) return clean(el.labels[0].innerText);
      if (['button', 'submit', 'reset'].includes(el.type) && el.value) return clean(el.value);
      return clean(el.placeholder || el.title || el.name || '');
    }
    if (tag === 'img') return clean(el.alt || el.title);
    const txt = clean(el.innerText || el.textContent);
    if (txt) return txt;
    const img = el.querySelector('img[alt], svg[aria-label], [aria-label]');
    if (img) return clean(img.getAttribute('alt') || img.getAttribute('aria-label'));
    return clean(el.title || '');
  }

  function describe(el, withRef = true) {
    const role = roleOf(el);
    let line = `${role} "${nameOf(el)}"`;
    if (withRef) line += ` [${refOf(el)}]`;
    if (role === 'link') {
      const h = el.getAttribute('href') || '';
      if (h && !h.startsWith('javascript:')) line += ` href="${clean(h, 120)}"`;
    }
    if (role === 'password') line += el.value ? ' value="•••"' : '';
    else if ('value' in el && ['textbox', 'searchbox', 'combobox', 'slider'].includes(role) && el.value) line += ` value="${clean(el.value, 80)}"`;
    else if (el.isContentEditable && role === 'textbox') {
      const v = clean(el.innerText, 80);
      if (v) line += ` value="${v}"`;
    }
    if (el.checked || el.getAttribute('aria-checked') === 'true') line += ' checked';
    if (el.getAttribute('aria-expanded')) line += ` expanded=${el.getAttribute('aria-expanded')}`;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' disabled';
    return line;
  }

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg', 'HEAD']);

  // Обход в порядке документа, с заходом в открытые shadow DOM и iframe того же сайта
  function collect(root, mode) {
    const out = [];
    const walk = (node) => {
      for (let n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) {
          if (mode === 'all') {
            const t = clean(n.textContent, 200);
            if (t.length > 1 && n.parentElement && visible(n.parentElement)) out.push({ text: t, el: n.parentElement });
          }
          continue;
        }
        if (n.nodeType !== 1 || SKIP.has(n.tagName)) continue;
        if (n.matches(INTERACTIVE) && visible(n)) {
          out.push({ el: n });
          continue; // текст внутри кнопки/ссылки уже в её названии
        }
        if (/^H[1-6]$/.test(n.tagName) && visible(n)) {
          out.push({ el: n, heading: true });
          continue;
        }
        if (mode === 'all' && n.tagName === 'IMG' && n.alt && visible(n)) out.push({ el: n });
        if (n.shadowRoot) walk(n.shadowRoot);
        if (n.tagName === 'IFRAME') {
          try { if (n.contentDocument && n.contentDocument.body) walk(n.contentDocument.body); } catch {}
        }
        walk(n);
      }
    };
    walk(root);
    return out;
  }

  function hasLogin() {
    return [...document.querySelectorAll('input[type=password]')].some(visible);
  }

  function header() {
    const total = document.documentElement.scrollHeight;
    return `URL: ${location.href}\nTitle: ${document.title}\nViewport: ${innerWidth}x${innerHeight}, scroll ${Math.round(scrollY)}/${total}\n---\n`;
  }

  function readPage({ filter = 'interactive', max_chars = 40000, ref_id }) {
    const root = ref_id ? byRef(ref_id) : document.body;
    const items = collect(root, filter);
    const lines = [];
    let prevText = '';
    for (const it of items) {
      if (it.text) {
        if (it.text !== prevText) lines.push(`text "${it.text}"`);
        prevText = it.text;
      } else if (it.heading) {
        lines.push(`heading "${clean(it.el.innerText)}" [${refOf(it.el)}]`);
      } else {
        lines.push(describe(it.el));
      }
    }
    let body = lines.join('\n');
    if (body.length > max_chars) body = body.slice(0, max_chars) + `\n[обрезано на ${max_chars} символах из ${body.length}; сузь через ref_id или find]`;
    if (!body) body = '(видимых элементов нет)';
    return { text: header() + body, login: hasLogin() };
  }

  function find({ query }) {
    const q = String(query || '').toLowerCase();
    const items = collect(document.body, 'all');
    const hits = [];
    for (const it of items) {
      const line = it.text ? `text "${it.text}" [${refOf(it.el)}]` : it.heading ? `heading "${clean(it.el.innerText)}" [${refOf(it.el)}]` : describe(it.el);
      if (line.toLowerCase().includes(q)) hits.push(line);
      if (hits.length >= 25) break;
    }
    return { text: hits.length ? hits.join('\n') : `Ничего не найдено по «${query}»`, login: hasLogin() };
  }

  /* ---------- действия ---------- */

  function target(a) {
    if (a.ref) return byRef(a.ref);
    if (a.x != null && a.y != null) {
      const el = document.elementFromPoint(a.x, a.y);
      if (!el) throw new Error(`В точке (${a.x}, ${a.y}) ничего нет.`);
      return el;
    }
    throw new Error('Нужен ref или координаты x, y.');
  }

  function center(el, a) {
    if (a.x != null && a.y != null && !a.ref) return [a.x, a.y];
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  function mouse(el, type, x, y, extra = {}) {
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, ...extra }));
  }

  function click(a) {
    const el = target(a);
    const [x, y] = center(el, a);
    const desc = describe(el, false);
    if (a.button === 'right') {
      mouse(el, 'pointerdown', x, y, { button: 2, buttons: 2 });
      mouse(el, 'mousedown', x, y, { button: 2, buttons: 2 });
      mouse(el, 'pointerup', x, y, { button: 2, buttons: 0 });
      mouse(el, 'mouseup', x, y, { button: 2, buttons: 0 });
      mouse(el, 'contextmenu', x, y, { button: 2, buttons: 0 });
      return { clicked: desc };
    }
    const times = a.double ? 2 : 1;
    for (let i = 0; i < times; i++) {
      mouse(el, 'pointerover', x, y, { buttons: 0 });
      mouse(el, 'mouseover', x, y, { buttons: 0 });
      mouse(el, 'pointerdown', x, y);
      mouse(el, 'mousedown', x, y);
      if (el.focus) el.focus({ preventScroll: true });
      mouse(el, 'pointerup', x, y, { buttons: 0 });
      mouse(el, 'mouseup', x, y, { buttons: 0 });
      if (typeof el.click === 'function') el.click();
      else mouse(el, 'click', x, y, { buttons: 0 });
    }
    if (a.double) mouse(el, 'dblclick', x, y, { buttons: 0, detail: 2 });
    return { clicked: desc };
  }

  function guard(el) {
    if (el.type === 'password') throw new Error('Пароли вводит только пользователь. Попроси его войти самому (автозаполнение Firefox подойдёт).');
    const ac = (el.getAttribute && el.getAttribute('autocomplete')) || '';
    if (/one-time-code/i.test(ac)) throw new Error('Коды подтверждения вводит только пользователь.');
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function typeText(a) {
    const el = a.ref ? byRef(a.ref) : document.activeElement;
    if (!el || el === document.body) throw new Error('Некуда вводить: укажи ref поля.');
    guard(el);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    const text = String(a.text ?? '');
    const clear = a.clear !== false;
    if (el.isContentEditable) {
      if (clear) document.execCommand('selectAll');
      if (!document.execCommand('insertText', false, text)) el.textContent = text;
    } else if ('value' in el) {
      if (clear) { try { el.select(); } catch {} }
      else { try { el.setSelectionRange(el.value.length, el.value.length); } catch {} }
      const before = el.value;
      const ok = document.execCommand('insertText', false, text);
      const want = clear ? text : before + text;
      if (!ok || el.value !== want) setNativeValue(el, want);
    } else {
      throw new Error('Этот элемент не принимает текст.');
    }
    if (a.submit) submitFrom(el);
    return { typed: describe(el, false) };
  }

  function submitFrom(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const down = el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (down && el.form && el.tagName !== 'TEXTAREA') {
      try { el.form.requestSubmit(); } catch { el.form.submit(); }
    }
  }

  const KEYCODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32, Space: 32 };

  function focusables() {
    return [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable=true]')]
      .filter((e) => !e.disabled && visible(e));
  }

  function key(a) {
    const combos = String(a.keys || a.text || '').split(/\s+/).filter(Boolean);
    const repeat = Math.max(1, Math.min(Number(a.repeat) || 1, 100));
    for (let i = 0; i < repeat; i++) {
      for (const combo of combos) {
        const parts = combo.split('+');
        let k = parts.pop();
        const mods = parts.map((p) => p.toLowerCase());
        if (k.toLowerCase() === 'space') k = ' ';
        if (k.length === 1 && !mods.length) k = k; // одиночный символ
        const el = document.activeElement || document.body;
        const ctrl = mods.includes('ctrl') || mods.includes('control') || mods.includes('cmd') || mods.includes('meta');
        const shift = mods.includes('shift');
        const opts = {
          key: k.length === 1 ? k : k.charAt(0).toUpperCase() + k.slice(1),
          code: k.length === 1 ? (/[a-z]/i.test(k) ? 'Key' + k.toUpperCase() : '') : k,
          keyCode: KEYCODES[k] || (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0),
          bubbles: true, cancelable: true, ctrlKey: ctrl, metaKey: mods.includes('meta'), shiftKey: shift, altKey: mods.includes('alt'),
        };
        const go = el.dispatchEvent(new KeyboardEvent('keydown', opts));
        if (go) {
          // Действие по умолчанию, которое браузер не делает для синтетических событий
          const isField = 'value' in el && el.tagName !== 'BUTTON' || el.isContentEditable;
          if (ctrl && k.toLowerCase() === 'a') { if (isField && el.select) el.select(); else document.execCommand('selectAll'); }
          else if (k === 'Enter' && !ctrl) { if (el.tagName === 'TEXTAREA' || el.isContentEditable) document.execCommand('insertLineBreak'); else if (el.form) { try { el.form.requestSubmit(); } catch {} } else if (el.click && el.matches('a,button,[role=button],summary')) el.click(); }
          else if (k === 'Tab') { const f = focusables(); const i2 = f.indexOf(el); const n = f[(i2 + (shift ? -1 : 1) + f.length) % f.length]; if (n) n.focus(); }
          else if (k === 'Backspace' && isField) document.execCommand('delete');
          else if (k === 'Delete' && isField) document.execCommand('forwardDelete');
          else if (k === 'PageDown' || (k === ' ' && !isField)) scrollBy(0, innerHeight * 0.85);
          else if (k === 'PageUp') scrollBy(0, -innerHeight * 0.85);
          else if (k === 'Home' && !isField) scrollTo(0, 0);
          else if (k === 'End' && !isField) scrollTo(0, document.documentElement.scrollHeight);
          else if (k.length === 1 && !ctrl && isField) { guard(el); document.execCommand('insertText', false, k); }
        }
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
      }
    }
    return { pressed: combos.join(' ') + (repeat > 1 ? ` ×${repeat}` : '') };
  }

  function scroll(a) {
    const amount = (Number(a.amount) || 3) * 120;
    const dir = a.direction;
    if (a.ref && !dir) {
      byRef(a.ref).scrollIntoView({ block: 'center', behavior: 'instant' });
    } else {
      const el = a.ref ? byRef(a.ref) : (a.x != null ? document.elementFromPoint(a.x, a.y) : null);
      const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
      const dy = dir === 'up' ? -amount : dir === 'down' || !dir ? amount : 0;
      let box = el;
      while (box && box !== document.body && !(box.scrollHeight > box.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
      if (box && box !== document.body) box.scrollBy(dx, dy);
      else scrollBy(dx, dy);
    }
    return { scrollY: Math.round(scrollY), height: document.documentElement.scrollHeight };
  }

  function hover(a) {
    const el = target(a);
    const [x, y] = center(el, a);
    for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
      mouse(el, t, x, y, { buttons: 0, bubbles: !t.endsWith('enter') });
    }
    return { hovered: describe(el, false) };
  }

  function formInput(a) {
    const el = byRef(a.ref);
    guard(el);
    const v = a.value;
    if (el.tagName === 'SELECT') {
      const opt = [...el.options].find((o) => o.value === String(v)) || [...el.options].find((o) => clean(o.text).toLowerCase() === String(v).toLowerCase());
      if (!opt) throw new Error('Нет такого варианта. Есть: ' + [...el.options].map((o) => clean(o.text)).join(' | '));
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: clean(opt.text) };
    }
    if (el.type === 'checkbox' || el.type === 'radio' || el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'switch') {
      const want = v === true || v === 'true' || v === 1 || v === 'on';
      const now = el.checked ?? el.getAttribute('aria-checked') === 'true';
      if (now !== want) el.click();
      return { checked: want };
    }
    return typeText({ ref: a.ref, text: v, clear: true });
  }

  function getText({ max_chars = 50000 }) {
    const root = document.querySelector('main, article, [role=main]') || document.body;
    let t = (root.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    if (t.length > max_chars) t = t.slice(0, max_chars) + `\n[обрезано, всего ${t.length} символов]`;
    return { text: header() + t, login: hasLogin() };
  }

  async function waitFor({ text, gone, timeout = 10 }) {
    const end = Date.now() + Math.min(Number(timeout) || 10, 60) * 1000;
    const want = String(text || '');
    while (Date.now() < end) {
      const has = document.body && document.body.innerText.includes(want);
      if (gone ? !has : has) return { found: !gone, text: want };
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`За ${timeout} с текст «${want}» ${gone ? 'не исчез' : 'не появился'}.`);
  }

  const handlers = {
    probe: () => ({ login: hasLogin() }),
    viewport: () => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }),
    read_page: readPage,
    find,
    get_text: getText,
    wait_for: waitFor,
    click,
    type: typeText,
    key,
    scroll,
    hover,
    form_input: formInput,
  };

  browser.runtime.onMessage.addListener((msg) => {
    const h = handlers[msg && msg.cmd];
    if (!h) return undefined;
    return (async () => h(msg.args || {}))();
  });
}
