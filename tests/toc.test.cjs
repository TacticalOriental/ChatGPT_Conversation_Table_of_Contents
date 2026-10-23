const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const sourcePath = process.env.TOC_SOURCE || path.join(__dirname, '..', 'ChatGPT_Conversation_Table_of_Contents.user.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function environment({ expose = true, pathname = '/' } = {}) {
  const listeners = new Map();
  const observers = [];
  const timers = new Map();
  const timerDelays = new Map();
  const frames = new Map();
  let nextId = 1;
  let focused = null;
  class Element {
    constructor(tag = 'div') {
      this.tag = tag;
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this.attributes = new Map();
      this.events = new Map();
      this.properties = new Map();
      this.style = { setProperty: (name, value) => this.properties.set(name, value) };
      this.className = '';
      this.scrollTop = 0;
      this.clientHeight = 334;
      this.scrollHeight = 334;
      this.isConnected = true;
      this.visible = true;
      this.classList = {
        contains: (name) => this.className.split(/\s+/).includes(name),
        add: (name) => { if (!this.classList.contains(name)) this.className += ` ${name}`; },
        remove: (name) => { this.className = this.className.split(/\s+/).filter((x) => x !== name).join(' '); },
        toggle: (name, present) => present ? this.classList.add(name) : this.classList.remove(name),
      };
    }
    append(...nodes) {
      for (const node of nodes) {
        if (node.tag === 'fragment') this.append(...node.children);
        else { node.parentElement = this; this.children.push(node); }
      }
    }
    replaceChildren(...nodes) {
      this.children.forEach((node) => { node.parentElement = null; node.isConnected = false; });
      this.children = [];
      this.append(...nodes);
    }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
      this.parentElement = null;
      this.isConnected = false;
    }
    attachShadow() { this.shadowRoot = new Element('shadow'); return this.shadowRoot; }
    get firstElementChild() { return this.children[0]; }
    get activeElement() { return this.contains(focused?.element) ? focused.element : null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(fn); }
    removeEventListener(name, fn) { this.events.set(name, (this.events.get(name) || []).filter((x) => x !== fn)); }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    matches(selector) {
      return selector.split(',').some((s) => s.trim().startsWith('.')
        ? this.classList.contains(s.trim().slice(1))
        : s.trim() === '[data-turn-key]' && this.attributes.has('data-turn-key'));
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    querySelectorAll(selector) {
      const result = [];
      for (const child of this.children) {
        if (child.matches(selector)) result.push(child);
        result.push(...child.querySelectorAll(selector));
      }
      return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    getClientRects() { return this.visible ? [{}] : []; }
    getBoundingClientRect() { return { top: this.top ?? 0, height: this.visible ? 100 : 0 }; }
    focus(options) { focused = { element: this, options }; }
    blur() { focused = null; }
  }
  const body = new Element('body');
  const document = {
    body,
    events: new Map(),
    addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(fn); },
    removeEventListener(name, fn) { this.events.set(name, (this.events.get(name) || []).filter((x) => x !== fn)); },
    getElementById(id) { return body.children.find((node) => node.id === id) ?? null; },
    createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element('fragment'),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    querySelector: (selector) => body.querySelector(selector),
    scrollingElement: body,
  };
  const location = { pathname, search: '', href: `https://chatgpt.com${pathname}` };
  const window = {
    innerHeight: 800, scrollY: 0,
    setTimeout(fn, delay) { const id = nextId++; timers.set(id, fn); timerDelays.set(id, delay); return id; },
    clearTimeout(id) { timers.delete(id); timerDelays.delete(id); },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    removeEventListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter((x) => x !== fn)); },
    dispatchEvent(event) { (listeners.get(event.type) || []).forEach((fn) => fn(event)); },
  };
  const storage = new Map();
  const context = vm.createContext({
    document, window, location, Element, Node: { ELEMENT_NODE: 1 },
    Event: class Event { constructor(type) { this.type = type; } },
    history: { pushState() {}, replaceState() {} },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() { this.live = true; } disconnect() { this.live = false; } },
    requestAnimationFrame(fn) { const id = nextId++; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    getComputedStyle: (element) => ({ flexDirection: element.direction ?? 'column', overflowY: 'auto' }),
    matchMedia: () => ({ matches: true }),
    URL, URLSearchParams, Headers, AbortController, DOMException, TypeError,
    fetch: async () => { throw new Error('Unexpected network call in fixture'); },
  });
  const executable = expose ? source.replace(/if \(document.body\) (?:new App\(\)\.start\(\)|bootstrap\(\));/,
    'globalThis.probe = { CONFIG, normalizeText, collectPromptText, promptsFromMessages, legacyActiveBranch, mergeRenderedPrompts, routeContext, ConversationSource, ChatGPTRequest, HttpError, App, TocView, ActiveTurnTracker, DomTurns };') : source;
  vm.runInContext(executable, context);
  return { context, probe: context.probe, document, window, location, Element, listeners, observers, timers, timerDelays, frames, focused: () => focused, rerun: () => vm.runInContext(source, context) };
}

// Only test fixtures use a fake clock/network. Run pending promise jobs before
// firing the earliest remaining timer (request deadline, retry, or batch yield).
async function drive(promise, e, limit = 1000) {
  let settled = false;
  let result;
  let failure;
  promise.then((value) => { settled = true; result = value; }, (error) => { settled = true; failure = error; });
  for (let step = 0; step < limit && !settled; step++) {
    await new Promise(setImmediate);
    if (settled) break;
    const timer = Array.from(e.timers).sort((a, b) => e.timerDelays.get(a[0]) - e.timerDelays.get(b[0]))[0];
    if (timer) { e.window.clearTimeout(timer[0]); timer[1](); }
  }
  assert.equal(settled, true, 'operation did not settle within the test fixture budget');
  if (failure) throw failure;
  return result;
}

const user = (id, text = id) => ({ id, author: { role: 'user' }, content: { parts: [text] } });
const plain = (value) => JSON.parse(JSON.stringify(value));
const items = (count, start = 0) => Array.from({ length: count }, (_, n) => ({ id: `p${start + n}`, text: `Prompt ${start + n}` }));

test('text extraction indexes only authored user text; no tool, hidden or attachment-only labels', () => {
  const { probe } = environment();
  const multimodal = user('mixed');
  multimodal.content.parts = [' Ask  about\nthis ', { type: 'input_text', text: 'please' }, { content_type: 'image_asset_pointer', asset_pointer: 'private-image' }, { name: 'file.pdf' }];
  assert.deepEqual(plain(probe.promptsFromMessages([
    user('a', ' hello\n  world '), multimodal,
    { ...user('assistant'), author: { role: 'assistant' } },
    { ...user('hidden'), metadata: { is_user_system_message: true } },
    { ...user('attachment'), content: { parts: [{ type: 'image' }] } }, user('a', 'duplicate'),
  ])).map(({ id, text }) => ({ id, text })), [{ id: 'a', text: 'hello world' }, { id: 'mixed', text: 'Ask about this please' }]);
});

test('D1: whitespace normalization preserves meaningful emoji joiners and word joiners', () => {
  const { probe } = environment();
  assert.equal(probe.normalizeText('  👩‍💻  می‌خواهم\n now '), '👩‍💻 می‌خواهم now');
});

test('legacy mapping follows only the current ancestry, not sibling branches', () => {
  const { probe } = environment();
  const data = { current_node: 'c', mapping: { a: { parent: null, message: user('a') }, b: { parent: 'a', message: user('b') }, c: { parent: 'a', message: user('c') } } };
  assert.deepEqual(plain(probe.legacyActiveBranch(data)).map((m) => m.id), ['a', 'c']);
});

test('route identity distinguishes personal/project/owner and accepts empty new chat', () => {
  const e = environment({ pathname: '/g/g-p-abcdef-test/c/1234567890123456' });
  e.location.search = '?owner_user_id=owner';
  assert.equal(e.probe.routeContext().key, 'g-p-abcdef:owner:1234567890123456');
  e.location.pathname = '/';
  assert.equal(e.probe.routeContext(), null);
});

test('paged index is chronological, deduplicated and independent of scrolling', async () => {
  const { probe } = environment();
  const calls = [];
  const adapter = new probe.ConversationSource({ async json(path) {
    calls.push(path);
    return calls.length === 1
      ? { messages: [user('b'), user('c')], page_info: { has_previous_page: true, start_cursor: 'older' } }
      : { messages: [user('a'), user('b')], page_info: { has_previous_page: false } };
  } });
  const progress = [];
  const result = await adapter.load({ conversationId: 'conversation' }, new AbortController().signal, (p) => { progress.push(p); });
  assert.deepEqual(plain(progress[0].items).map((x) => x.id), ['b', 'c']);
  assert.equal(progress[0].status, 'partial');
  assert.deepEqual(plain(result.items).map((x) => x.id), ['a', 'b', 'c']);
  assert.equal(result.status, 'complete');
  assert.equal(result.checkpoint, null);
  assert.equal(calls.length, 2);
});

test('empty API conversation remains a genuine empty success', async () => {
  const { probe } = environment();
  const adapter = new probe.ConversationSource({ json: async () => ({ messages: [], page_info: { has_previous_page: false } }) });
  assert.deepEqual(plain(await adapter.load({ conversationId: 'conversation' })), { items: [], status: 'complete', checkpoint: null });
});

test('D2: malformed API shape cannot masquerade as a complete empty conversation', async () => {
  const { probe } = environment();
  const adapter = new probe.ConversationSource({ json: async () => ({ unexpected_schema: true }) });
  await assert.rejects(adapter.load({ conversationId: 'conversation' }));
});

test('D3: repeated pagination cursor must report incomplete history', async () => {
  const { probe } = environment();
  const adapter = new probe.ConversationSource({ json: async () => ({ messages: [user('a')], page_info: { has_previous_page: true, start_cursor: 'same' } }) });
  await assert.rejects(adapter.load({ conversationId: 'conversation' }));
});

test('D4: a progressing history larger than the former ceiling completes without truncation', async () => {
  const e = environment();
  const { probe } = e;
  let page = 0;
  const adapter = new probe.ConversationSource({ json: async () => ({ messages: [user(String(++page))], page_info: { has_previous_page: page < 121, start_cursor: String(page) } }) });
  const result = await drive(adapter.load({ conversationId: 'conversation' }), e);
  assert.equal(result.status, 'complete');
  assert.equal(result.items.length, 121);
  assert.equal(result.items[0].id, '121');
  assert.equal(result.items.at(-1).id, '1');
});

test('API 401 refresh retries once and sends only same-origin GETs', async () => {
  const e = environment();
  const calls = [];
  const responses = [{ ok: false, status: 401 }, { ok: true, status: 200, json: async () => ({ accessToken: 'fixture-token' }) }, { ok: true, status: 200, json: async () => ({ messages: [] }) }];
  e.context.fetch = async (path, options) => { calls.push({ path, options }); return responses.shift(); };
  const request = new e.probe.ChatGPTRequest();
  request.token = 'fixture-stale-token';
  await request.json('/backend-api/conversations/c');
  assert.deepEqual(calls.map((x) => x.path), ['/backend-api/conversations/c', '/api/auth/session', '/backend-api/conversations/c']);
  assert.ok(calls.every((x) => x.options.method === 'GET' && x.path.startsWith('/')));
  assert.equal(calls.at(-1).options.signal.aborted, false, 'successful reads must not be reported as cancelled');
});

test('aborted source loads do not fall back to another endpoint', async () => {
  const { probe } = environment();
  let calls = 0;
  const adapter = new probe.ConversationSource({ json: async () => { calls++; throw new DOMException('aborted', 'AbortError'); } });
  await assert.rejects(adapter.load({ conversationId: 'conversation' }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

function appFixture(probe, sourceAdapter, rendered = items(1)) {
  const app = Object.create(probe.App.prototype);
  Object.assign(app, {
    context: { key: 'chat-a', conversationId: 'chat-a' },
    sourceItems: [], loadController: null, loadSequence: 0, source: sourceAdapter,
    items: [], checkpoint: null, loadState: 'idle', hasCompleteIndex: false,
    cache: new Map(), lastRefreshMismatch: '', refreshRequests: 0, renders: 0,
    view: { setStatus() {} },
    refreshSoon() { this.refreshRequests++; },
    renderCurrent() { this.renders++; return rendered; },
    maybeRefreshData(next = rendered) { return probe.App.prototype.maybeRefreshData.call(this, next); },
  });
  app.refreshSoon.cancel = () => {};
  return app;
}

test('stale asynchronous results cannot overwrite a newly selected route', async () => {
  const { probe } = environment();
  let resolve;
  const app = appFixture(probe, { load: () => new Promise((r) => { resolve = r; }) });
  const loading = app.refreshData();
  app.loadController.abort();
  app.context = { key: 'chat-b', conversationId: 'chat-b' };
  app.loadSequence++;
  resolve({ items: items(2), status: 'complete', checkpoint: null });
  await loading;
  assert.equal(app.renders, 0);
  assert.equal(app.cache.size, 0);
});

test('D5: initial transient failure has a recovery path without changing conversations', async () => {
  const e = environment();
  const { probe } = e;
  let attempts = 0;
  e.context.fetch = async () => {
    if (++attempts === 1) throw new TypeError('temporary network failure');
    return { ok: true, json: async () => ({ messages: [user('p0', 'Prompt 0'), user('p1', 'Prompt 1')], page_info: { has_previous_page: false } }) };
  };
  const request = new probe.ChatGPTRequest();
  request.token = 'fixture-token';
  const app = appFixture(probe, new probe.ConversationSource(request));
  await drive(app.refreshData(), e);
  assert.equal(app.sourceItems.length, 2, 'history must become available after the transient failure');
  assert.equal(app.loadState, 'complete');
  assert.equal(attempts, 2);
  assert.equal(app.refreshRequests, 0, 'retry ownership must not multiply across App and HTTP');
});

test('D6: older-page transient failure can resume instead of freezing at the first page', async () => {
  const e = environment();
  const { probe } = e;
  const calls = [];
  const recent = items(1, 100);
  e.context.fetch = async (path) => {
    const before = new URL(path, 'https://chatgpt.com').searchParams.get('before');
    calls.push(before);
    if (before === 'oldest' && calls.filter((x) => x === before).length === 1) throw new TypeError('older page failed');
    const messages = before === 'oldest' ? [user('p0', 'Prompt 0')] : before === 'older' ? items(99, 1).map((p) => user(p.id, p.text)) : [user('p100', 'Prompt 100')];
    const page_info = { has_previous_page: before !== 'oldest', start_cursor: before === 'older' ? 'oldest' : 'older' };
    return { ok: true, json: async () => ({ messages, page_info }) };
  };
  const request = new probe.ChatGPTRequest();
  request.token = 'fixture-token';
  const app = appFixture(probe, new probe.ConversationSource(request), recent);
  await drive(app.refreshData(), e);
  assert.equal(app.sourceItems.length, 101, 'successful first page is not complete history');
  assert.equal(app.loadState, 'complete');
  assert.deepEqual(calls, [null, 'older', 'oldest', 'oldest']);
  assert.equal(new Set(app.sourceItems.map((p) => p.id)).size, 101);
});

test('all prompts remain in one panel and render is unchanged for identical input', () => {
  const { probe } = environment();
  const view = new probe.TocView(() => {});
  const list = items(231);
  view.render(list);
  assert.equal(view.panelList.children.length, 231);
  assert.equal(view.railList.children.length, 15);
  const first = view.panelList.firstElementChild;
  view.render(list);
  assert.equal(view.panelList.firstElementChild, first);
  view.setActive('p200');
  view.setOpen(true);
  assert.equal(view.panel.scrollTop, 200 * 46 + 6 + 23 - 167);
  const top = view.panel.scrollTop;
  view.setActive('p201');
  assert.equal(view.panel.scrollTop, top, 'chat location changes must not move an open panel');
});

test('D7: marker can reach the correct earlier section after older-prefix discovery', () => {
  const { probe } = environment();
  const view = new probe.TocView(() => {});
  view.render(items(100, 100));
  view.setActive('p100');
  view.render(items(200));
  view.setActive('p99');
  assert.equal(view.railSlot, 7, 'p99 is at the midpoint of the complete 200-prompt index');
});

test('D8: focusing the rail opens with the focused prompt visible in the panel', () => {
  const e = environment();
  const view = new e.probe.TocView(() => {});
  view.render(items(231));
  view.setActive('p200');
  view.dock.events.get('focusin')[0]({ target: view.railList.firstElementChild.firstElementChild });
  const focusedRow = e.focused().element.parentElement;
  const index = view.panelList.children.indexOf(focusedRow);
  const top = index * 46 + 6;
  assert.ok(top + 46 > view.panel.scrollTop && top < view.panel.scrollTop + view.panel.clientHeight, 'focused item is offscreen');
});

test('D9: repeated actual entry-point initialization has one active observer/listener set', () => {
  const e = environment({ expose: false });
  e.rerun();
  assert.equal(e.observers.filter((x) => x.live).length, 1);
  assert.equal(e.listeners.get('popstate').length, 1);
});

test('normal scroll sections and reverse bottom snap select real visible nodes', () => {
  const e = environment();
  const seen = [];
  const tracker = new e.probe.ActiveTurnTracker((id) => seen.push(id));
  const nodes = [-2507, -1684, -889, -162, 357].map((top, i) => { const node = new e.Element(); node.top = top; node.setAttribute('data-turn-key', `p${i}`); return node; });
  const scroller = new e.Element();
  scroller.append(...nodes);
  scroller.scrollTop = -26;
  scroller.scrollHeight = 3521;
  scroller.clientHeight = 884;
  tracker.nodes = nodes; tracker.scroller = scroller; tracker.reverseScroller = true;
  tracker.chooseActive();
  assert.equal(seen.at(-1), 'p4');
  scroller.scrollTop = -936;
  nodes.forEach((node) => { node.top += 936; });
  tracker.chooseActive();
  assert.equal(seen.at(-1), 'p2');
  nodes[2].isConnected = false;
  const calls = seen.length;
  tracker.chooseActive();
  assert.equal(seen.length, calls);
});

test('assistant token mutations do not reconcile the prompt index; a user-text edit does', () => {
  const e = environment();
  let disconnects = 0;
  let reconciles = 0;
  const app = Object.create(e.probe.App.prototype);
  Object.assign(app, {
    lastHref: e.location.href,
    activeTracker: { disconnect() { disconnects++; } },
    reconcileSoon() { reconciles++; },
  });
  const assistantRecords = Array.from({ length: 100 }, () => ({
    type: 'characterData', target: { parentElement: { closest: () => null } },
  }));
  app.onMutations(assistantRecords);
  assert.equal(reconciles, 0);
  assert.equal(disconnects, 0);
  app.onMutations([{ type: 'characterData', target: { parentElement: { closest: () => ({}) } } }]);
  assert.equal(reconciles, 1);
  assert.equal(disconnects, 1);
});

test('D10: a collapsed DOM preview must not replace a complete source prompt', () => {
  const { probe } = environment();
  const full = 'Long authored prompt: ' + 'meaningful content '.repeat(900) + 'final instruction';
  const sourceItems = [{ id: 'long', text: full }];
  const rendered = [{ id: 'long', text: full.slice(0, 10000) }];
  const merged = probe.mergeRenderedPrompts(sourceItems, rendered);
  assert.equal(merged[0].text.length, full.length, 'complete source text was replaced by its truncated DOM representation');
  assert.equal(merged[0].text, full);
});

test('schema validation rejects ambiguous pagination and malformed message records', async () => {
  const { probe } = environment();
  for (const payload of [
    { messages: [] },
    { messages: [], page_info: { has_previous_page: 'false' } },
    { messages: [], page_info: { has_previous_page: true } },
    { messages: [{}], page_info: { has_previous_page: false } },
  ]) {
    const source = new probe.ConversationSource({ json: async () => payload });
    await assert.rejects(source.load({ key: 'schema', conversationId: 'schema' }), (error) => error.cause?.name === 'ConversationDataError');
  }
});

test('nested pages and tool-only pages preserve ordering without false no-progress errors', async () => {
  const { probe } = environment();
  const pages = [
    { messages: [user('new')], page_info: { has_previous_page: true, start_cursor: 'tools' } },
    { conversation: { messages: [{ ...user('tool'), author: { role: 'tool' } }], page_info: { has_previous_page: true, start_cursor: 'old' } } },
    { messages: [user('old')], page_info: { has_previous_page: false } },
  ];
  const source = new probe.ConversationSource({ json: async () => pages.shift() });
  const result = await source.load({ key: 'chat', conversationId: 'chat' });
  assert.equal(result.status, 'complete');
  assert.deepEqual(plain(result.items).map((p) => p.id), ['old', 'new']);
});

test('cursor loops and duplicate-only history retain the last validated checkpoint', async () => {
  const { probe } = environment();
  for (const cursor of ['cursor-a', 'cursor-b']) {
    let count = 0;
    const source = new probe.ConversationSource({ json: async () => ({
      messages: [user('new')], page_info: { has_previous_page: true, start_cursor: ++count === 1 ? 'cursor-a' : cursor },
    }) });
    await assert.rejects(source.load({ key: 'chat', conversationId: 'chat' }), (error) => {
      assert.equal(error.cause.name, 'ConversationDataError');
      assert.equal(error.checkpoint.complete, false);
      assert.equal(error.checkpoint.pages, 1);
      assert.equal(error.checkpoint.cursor, 'cursor-a');
      assert.deepEqual(plain(error.checkpoint.items).map((p) => p.id), ['new']);
      return true;
    });
  }
});

test('legacy fallback is restricted to an unsupported first endpoint and the active branch', async () => {
  const { probe } = environment();
  const calls = [];
  const source = new probe.ConversationSource({ json: async (path) => {
    calls.push(path);
    if (calls.length === 1) throw new probe.HttpError(404, path);
    return { current_node: 'chosen', mapping: {
      root: { parent: null, message: user('root') },
      chosen: { parent: 'root', message: user('chosen') },
      sibling: { parent: 'root', message: user('sibling') },
    } };
  } });
  const result = await source.load({ key: 'chat', conversationId: 'chat' });
  assert.equal(result.status, 'complete');
  assert.deepEqual(plain(result.items).map((p) => p.id), ['root', 'chosen']);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].startsWith('/backend-api/conversation/'));

  let count = 0;
  const history = new probe.ConversationSource({ json: async (path) => {
    if (++count > 1) throw new probe.HttpError(404, path);
    return { messages: [user('new')], page_info: { has_previous_page: true, start_cursor: 'old' } };
  } });
  await assert.rejects(history.load({ key: 'chat', conversationId: 'chat' }), (error) => error.checkpoint.pages === 1);
  assert.equal(count, 2, 'a failed older page must not restart at the legacy endpoint');
});

test('malformed legacy graphs cannot hide broken ancestry as a complete result', async () => {
  const { probe } = environment();
  for (const graph of [
    { mapping: { a: { parent: 'missing', message: user('a') } }, current_node: 'a' },
    { mapping: { a: { parent: 'a', message: user('a') } }, current_node: 'a' },
    { mapping: { a: { parent: null, message: user('a') } } },
  ]) {
    const source = new probe.ConversationSource({ json: async () => graph });
    await assert.rejects(source.loadLegacy({ conversationId: 'chat' }), { name: 'ConversationDataError' });
  }
});

test('hung reads have bounded attempts, settle, and release all deadline timers', async () => {
  for (const hangBody of [false, true]) {
    const e = environment();
    const signals = [];
    e.context.fetch = (_path, options) => {
      signals.push(options.signal);
      return hangBody ? Promise.resolve({ ok: true, json: () => new Promise(() => {}) }) : new Promise(() => {});
    };
    const request = new e.probe.ChatGPTRequest();
    request.token = 'fixture-token';
    await assert.rejects(drive(request.json('/backend-api/conversations/chat'), e), { name: 'RequestTimeoutError' });
    assert.equal(signals.length, 3);
    assert.ok(signals.every((signal) => signal.aborted));
    assert.equal(e.timers.size, 0);
  }
});

test('route cancellation settles even when fetch ignores the signal', async () => {
  const e = environment();
  let calls = 0;
  e.context.fetch = () => { calls++; return new Promise(() => {}); };
  const request = new e.probe.ChatGPTRequest();
  request.token = 'fixture-token';
  const controller = new AbortController();
  const pending = request.json('/backend-api/conversations/chat', { signal: controller.signal });
  await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(e.timers.size, 0);
});

test('cancelling retry backoff prevents another request and releases its timer', async () => {
  const e = environment();
  let calls = 0;
  e.context.fetch = async () => { calls++; throw new TypeError('offline'); };
  const request = new e.probe.ChatGPTRequest();
  request.token = 'fixture-token';
  const controller = new AbortController();
  const pending = request.json('/backend-api/conversations/chat', { signal: controller.signal });
  await new Promise(setImmediate);
  assert.equal(e.timers.size, 1);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(e.timers.size, 0);
});

test('permanent errors and long Retry-After are not blindly retried', async () => {
  for (const status of [403, 404, 429]) {
    const e = environment();
    let calls = 0;
    e.context.fetch = async () => { calls++; return { ok: false, status, headers: new Headers({ 'Retry-After': '120' }) }; };
    const request = new e.probe.ChatGPTRequest();
    request.token = 'fixture-token';
    await assert.rejects(request.json('/backend-api/conversations/chat'), (error) => error.status === status);
    assert.equal(calls, 1);
    assert.equal(e.timers.size, 0);
  }
});

test('repeated 401 does not produce an authentication loop', async () => {
  const e = environment();
  const calls = [];
  e.context.fetch = async (path) => {
    calls.push(path);
    return path === '/api/auth/session' ? { ok: true, json: async () => ({ accessToken: 'fixture-fresh' }) } : { ok: false, status: 401 };
  };
  const request = new e.probe.ChatGPTRequest();
  request.token = 'fixture-token';
  await assert.rejects(request.json('/backend-api/conversations/chat'), (error) => error.status === 401);
  assert.deepEqual(calls, ['/backend-api/conversations/chat', '/api/auth/session', '/backend-api/conversations/chat']);
});

test('exhausted older-page reads remain partial, then resume the checkpoint on connectivity recovery', async () => {
  const e = environment();
  const calls = [];
  let offline = true;
  e.context.fetch = async (path) => {
    const before = new URL(path, 'https://chatgpt.com').searchParams.get('before');
    calls.push(before);
    if (before === 'oldest' && offline) throw new TypeError('offline');
    const messages = [user(before === 'oldest' ? 'p0' : before === 'middle' ? 'p1' : 'p2', before === 'oldest' ? 'Prompt 0' : before === 'middle' ? 'Prompt 1' : 'Prompt 2')];
    return { ok: true, json: async () => ({ messages, page_info: { has_previous_page: before !== 'oldest', start_cursor: before === 'middle' ? 'oldest' : 'middle' } }) };
  };
  const request = new e.probe.ChatGPTRequest();
  request.token = 'fixture-token';
  const app = appFixture(e.probe, new e.probe.ConversationSource(request), items(1, 2));
  await drive(app.refreshData(), e);
  assert.equal(app.loadState, 'partial');
  assert.equal(app.cache.size, 0, 'partial history must not enter the complete-index cache');
  assert.equal(app.checkpoint.cursor, 'oldest');
  assert.equal(app.checkpoint.pages, 2);
  assert.deepEqual(plain(app.sourceItems).map((p) => p.id), ['p1', 'p2']);
  for (let i = 0; i < 20; i++) app.maybeRefreshData(items(1, 2));
  assert.equal(app.refreshRequests, 0, 'host mutations must not multiply exhausted retries');
  assert.equal(e.timers.size, 0);
  offline = false;
  await drive(app.recoverData(true), e);
  assert.deepEqual(calls, [null, 'middle', 'oldest', 'oldest', 'oldest', 'oldest']);
  assert.equal(app.loadState, 'complete');
  assert.equal(app.checkpoint, null);
  assert.equal(app.cache.size, 1);
  assert.deepEqual(plain(app.sourceItems).map((p) => p.id), ['p0', 'p1', 'p2']);
});

test('failed schema stays truthful without automatic recovery storms', async () => {
  const e = environment();
  let calls = 0;
  const source = new e.probe.ConversationSource({ json: async () => { calls++; return { changed_schema: true }; } });
  const app = appFixture(e.probe, source);
  await app.refreshData();
  assert.equal(app.loadState, 'unavailable');
  assert.equal(app.cache.size, 0);
  for (let n = 0; n < 20; n++) { app.maybeRefreshData(); app.recoverData(true); }
  assert.equal(calls, 1);
  assert.equal(app.refreshRequests, 0);
});

test('complete text does not cause refreshes from collapsed prefixes; genuine edits still do', () => {
  const e = environment();
  const app = appFixture(e.probe, {});
  app.loadState = 'complete';
  app.sourceItems = [{ id: 'long', text: 'A complete prompt with its important final instruction' }];
  app.maybeRefreshData([{ id: 'long', text: 'A complete prompt' }]);
  assert.equal(app.refreshRequests, 0);
  app.maybeRefreshData([{ id: 'long', text: 'An edited prompt' }]);
  assert.equal(app.refreshRequests, 1);
  app.maybeRefreshData([{ id: 'new', text: 'A new submission' }]);
  assert.equal(app.refreshRequests, 2);
});

test('one discrete marker maps both edges and remaps an unchanged active ID after a prepend', () => {
  const e = environment();
  const view = new e.probe.TocView(() => {});
  view.render(items(100, 100));
  view.setActive('p100');
  view.render(items(200));
  assert.equal(view.railSlot, 7, 'index revision alone must remap the known active identity');
  for (const [id, slot] of [['p0', 0], ['p99', 7], ['p199', 14]]) {
    view.setActive(id);
    assert.equal(view.railSlot, slot);
    assert.equal(view.railList.children.filter((row) => row.classList.contains('tm-cgpt-toc__rail-row--active')).length, 1);
  }
});

test('mouse entry always centers on reading position and wheel scrolling remains independent', () => {
  const e = environment();
  const view = new e.probe.TocView(() => {});
  view.render(items(231));
  view.setActive('p120');
  for (const slot of [0, 14]) {
    view.setOpen(false);
    view.dock.events.get('pointerenter')[0]({ target: view.railList.children[slot] });
    assert.equal(view.panel.scrollTop, 120 * 46 + 6 + 23 - 167);
    let prevented = false;
    view.onWheel({ deltaY: 3, deltaMode: 1, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    const top = view.panel.scrollTop;
    view.setActive('p121');
    assert.equal(view.panel.scrollTop, top);
    view.setActive('p120');
  }
});

test('focus keeps the panel open, hidden rail buttons leave the tab order, and focus exit closes it', async () => {
  const e = environment();
  const view = new e.probe.TocView(() => {});
  view.render(items(231));
  view.dock.events.get('focusin')[0]({ target: view.railList.firstElementChild.firstElementChild });
  assert.ok(view.railList.children.every((row) => row.firstElementChild.tabIndex === -1));
  view.dock.events.get('pointerleave')[0]();
  for (const [id, fn] of e.timers) { e.window.clearTimeout(id); fn(); }
  assert.equal(view.open, true, 'keyboard focus inside the control must not be hidden by the close delay');
  const outside = new e.Element();
  outside.focus();
  view.dock.events.get('focusout')[0]({ relatedTarget: outside });
  for (const [id, fn] of e.timers) { e.window.clearTimeout(id); fn(); }
  assert.equal(view.open, false);
  assert.ok(view.railList.children.every((row) => row.firstElementChild.tabIndex === 0));
});

test('many real entry-point reinjections leave one instance and preserve another history wrapper', () => {
  const e = environment({ expose: false });
  let foreignCalls = 0;
  const original = e.context.history.pushState;
  e.context.history.pushState = function (...args) { foreignCalls++; return original.apply(this, args); };
  for (let n = 0; n < 8; n++) e.rerun();
  e.context.history.pushState({}, '', '/');
  assert.equal(foreignCalls, 1);
  assert.equal(e.observers.filter((observer) => observer.live).length, 1);
  assert.equal(e.listeners.get('popstate').length, 1);
  assert.equal(e.document.events.get('visibilitychange').length, 1);
  assert.equal(e.document.body.children.filter((node) => node.id === 'tm-cgpt-toc-root').length, 1);
});

test('destroying during an in-flight read releases listeners, observers, timers, frames, and host', async () => {
  const e = environment({ pathname: '/c/conversation12345' });
  e.context.fetch = () => new Promise(() => {});
  const app = new e.probe.App();
  app.start();
  await new Promise(setImmediate);
  assert.ok(app.loadController);
  app.destroy();
  await new Promise(setImmediate);
  assert.equal(e.timers.size, 0);
  assert.equal(e.frames.size, 0);
  assert.equal(e.observers.filter((observer) => observer.live).length, 0);
  assert.ok([...e.listeners.values()].every((callbacks) => callbacks.length === 0));
  assert.ok([...e.document.events.values()].every((callbacks) => callbacks.length === 0));
  assert.equal(e.document.getElementById('tm-cgpt-toc-root'), null);
  assert.equal(app.sourceItems.length, 0);
});

test('repeated SPA switches keep one resource set, clear new-chat entries, and bound the cache', async () => {
  const e = environment();
  const app = new e.probe.App();
  app.source = { load: async (context) => ({ items: [{ id: context.conversationId, text: context.conversationId }], status: 'complete', checkpoint: null }) };
  app.start();
  for (let n = 0; n < 12; n++) {
    e.location.pathname = `/c/conversation${String(n).padStart(4, '0')}`;
    e.location.href = `https://chatgpt.com${e.location.pathname}`;
    await app.checkRoute();
    assert.equal(app.items[0].id, `conversation${String(n).padStart(4, '0')}`);
  }
  assert.equal(app.cache.map.size, 8);
  assert.equal(e.observers.filter((observer) => observer.live).length, 1);
  assert.equal(e.listeners.get('popstate').length, 1);
  e.location.pathname = '/'; e.location.href = 'https://chatgpt.com/';
  app.checkRoute();
  assert.equal(app.items.length, 0);
  assert.equal(app.view.host.hidden, true);
  app.destroy();
});

test('ordinary startup with a mounted prompt neither scrolls nor queues a redundant full refresh', async () => {
  const e = environment({ pathname: '/c/conversation12345' });
  let calls = 0;
  let scrolls = 0;
  e.window.scrollTo = () => { scrolls++; };
  e.probe.DomTurns.scrollTo = () => { scrolls++; return true; };
  e.probe.DomTurns.prompts = () => items(1);
  e.context.fetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ messages: [user('p0', 'Prompt 0')], page_info: { has_previous_page: false } }) };
  };
  const app = new e.probe.App();
  app.request.token = 'fixture-token';
  app.start();
  await new Promise(setImmediate);
  assert.equal(app.loadState, 'complete');
  assert.equal(calls, 1);
  assert.equal(scrolls, 0);
  assert.equal(e.timers.size, 0, 'an immediate load must cancel/supersede any queued refresh');
  app.destroy();
});

test('keyboard focus survives a history prepend without being left on a detached row', () => {
  const e = environment();
  const view = new e.probe.TocView(() => {});
  view.render(items(30, 100));
  view.setActive('p110');
  view.setOpen(true);
  view.panelList.children[10].firstElementChild.focus();
  view.render(items(130));
  assert.equal(e.focused().element.dataset.messageId, 'p110');
  assert.equal(view.panelById.get('p110').firstElementChild, e.focused().element);
  const top = 110 * 46 + 6;
  assert.ok(top >= view.panel.scrollTop && top + 46 <= view.panel.scrollTop + view.panel.clientHeight);
});

test('recovery cooldown and server guidance are respected even on online events', async () => {
  const e = environment();
  let calls = 0;
  const source = new e.probe.ConversationSource({ json: async () => {
    calls++;
    throw new e.probe.HttpError(429, '/backend-api/conversations/chat', 120000);
  } });
  const app = appFixture(e.probe, source);
  await app.refreshData();
  app.retryAvailableAt = 0;
  for (let n = 0; n < 10; n++) app.recoverData(true);
  assert.equal(calls, 1, 'online is not permission to violate Retry-After');
});

test('a refreshed authoritative edit replaces old full text without trusting the editor/DOM preview', async () => {
  const e = environment();
  const app = appFixture(e.probe, { load: async () => ({
    items: [{ id: 'same-id', text: 'Complete edited prompt, including its ending' }],
    status: 'complete', checkpoint: null,
  }) }, [{ id: 'same-id', text: 'Complete edited prompt' }]);
  app.sourceItems = [{ id: 'same-id', text: 'Original prompt, including its ending' }];
  app.hasCompleteIndex = true;
  await app.refreshData();
  assert.equal(app.sourceItems[0].text, 'Complete edited prompt, including its ending');
  assert.equal(e.probe.mergeRenderedPrompts(app.sourceItems, [{ id: 'same-id', text: 'Complete edited prompt' }])[0].text, app.sourceItems[0].text);
});
