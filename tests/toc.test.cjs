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
    get activeElement() { return focused?.element ?? body; },
    events: new Map(),
    addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(fn); },
    removeEventListener(name, fn) { this.events.set(name, (this.events.get(name) || []).filter((x) => x !== fn)); },
    getElementById(id) { return body.children.find((node) => node.id === id) ?? null; },
    createElement: (tag) => new Element(tag),
    createElementNS: (_ns, tag) => new Element(tag),
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
    URL, URLSearchParams, Headers, AbortController, DOMException, TypeError, performance,
    fetch: async () => { throw new Error('Unexpected network call in fixture'); },
  });
  const executable = expose ? source.replace(/if \(document.body\) (?:new App\(\)\.start\(\)|bootstrap\(\));/,
    'globalThis.probe = { CONFIG, SEARCH, PromptSearch, searchDocument, boundedEditDistance, wordMatchScore, searchPreview, cachedPreviewMeasure, normalizeText, collectPromptText, promptsFromMessages, legacyActiveBranch, mergeRenderedPrompts, routeContext, ConversationSource, ChatGPTRequest, HttpError, App, TocView, ActiveTurnTracker, DomTurns };') : source;
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

async function findPrompts(texts, query) {
  const e = environment();
  const search = new e.probe.PromptSearch();
  search.setItems(texts.map((text, i) => ({ id: String(i), text })));
  const results = await drive(search.find(query), e);
  return { e, search, results: plain(results) };
}

async function finishQuery(view, e, value) {
  view.setQuery(value);
  view.searchSoon.cancel();
  if (view.query) await drive(view.runSearch(), e);
}

const displayedIds = (view) => plain(view.entries).map(({ item }) => item.id);

function descendantText(node) {
  return (node.textContent || '') + node.children.map(descendantText).join('');
}

test('search ignores casing, accents, repeated whitespace, and punctuation; all terms are required', async () => {
  const texts = ['A CAFÉ in Montréal with résumé tips', 'Tire-pressure in winter', 'Pressure on a bicycle tire', 'A tire and no matching term'];
  assert.deepEqual((await findPrompts(texts, 'cafe   resume')).results.map(r => r.item.id), ['0']);
  assert.deepEqual((await findPrompts(texts, '  PRESSURE\nTIRE ')).results.map(r => r.item.id), ['1', '2']);
  assert.deepEqual((await findPrompts(texts, 'tire nonexistent')).results, []);
});

test('search tolerates transpositions, substitutions, insertions and deletions at conservative lengths', async () => {
  const text = 'Discuss battery voltage and maintenance';
  for (const query of ['battrey', 'batery', 'batttery', 'battary', 'voltge', 'maintenacne', 'maintanence']) {
    const { results } = await findPrompts([text, 'A fully unrelated topic about books'], query);
    assert.deepEqual(results.map(r => r.item.id), ['0'], query);
  }
  assert.deepEqual((await findPrompts([text], 'bttr')).results, []);
  assert.deepEqual((await findPrompts(['cat', 'dog', 'car', 'battery'], 'car')).results.map(r => r.item.id), ['2']);
});

test('search supports word prefixes and missing/extra spaces without arbitrary substring noise', async () => {
  for (const query of ['tirepressure', 'ti re pres sure', 'tirepressur', 'tire press']) {
    assert.deepEqual((await findPrompts(['What about tire pressure?', 'How does a train work?'], query)).results.map(r => r.item.id), ['0'], query);
  }
  assert.deepEqual((await findPrompts(['A train is waiting', 'rain'], 'rain')).results.map(r => r.item.id), ['1']);
  assert.deepEqual((await findPrompts(['The international topic'], 'inter')).results.map(r=>r.item.id), ['0'], 'a literal prefix must not depend on the complete word length');
});

test('numeric prefixes are progressive while numeric substitutions and code names stay precise', async () => {
  const texts = ['Invoice 2025 amount 1000', 'Invoice 2026 amount 10001', 'C++ is distinct', 'C# is distinct'];
  assert.deepEqual((await findPrompts(texts, '2025')).results.map(r => r.item.id), ['0']);
  assert.deepEqual((await findPrompts(texts, '1000')).results.map(r => r.item.id), ['0','1']);
  assert.deepEqual((await findPrompts(texts, '10001')).results.map(r => r.item.id), ['1']);
  assert.deepEqual((await findPrompts(texts, '2027')).results, []);
  assert.deepEqual((await findPrompts(texts, 'C++')).results.map(r => r.item.id), ['2']);
  assert.deepEqual((await findPrompts(texts, 'C#')).results.map(r => r.item.id), ['3']);
});

test('bounded edit distance agrees with an independent full-matrix OSA oracle', () => {
  const { probe } = environment();
  function oracle(a, b) {
    a = Array.from(a); b = Array.from(b);
    const matrix = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i ? (j ? 0 : i) : j));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
    }
    return matrix[a.length][b.length];
  }
  const words = ['','a','b','aa','ab','ba','abc','cab','battery','battrey','maintenacne','maintenance','é𐐷ab','éa𐐷b'];
  for (const a of words) for (const b of words) for (const limit of [0,1,2]) {
    assert.equal(probe.boundedEditDistance(a, b, limit), Math.min(oracle(a,b), limit + 1), `${a}/${b}/${limit}`);
  }
});

test('search reaches the end of complete long prompts and preserves chronology and original text', async () => {
  const long = 'Introduction and the original beginning. ' + 'ordinary material '.repeat(6000) + 'Battery voltage in winter finally appears here.';
  const { results } = await findPrompts(['A battery voltage question', 'Unrelated text', long], 'battrey voltge');
  assert.deepEqual(results.map(r => r.item.id), ['0', '2']);
  assert.equal(results[1].item.text, long);
  assert.ok(results[1].ranges.every(range => range.start > 100000));
});

test('Unicode matches highlight original source offsets after normalization and around emoji', async () => {
  for (const [text, query, expected] of [
    ['👩‍💻 Please compare CAFÉ ideas', 'cafe', 'CAFÉ'],
    ['A Straße in Germany', 'strasse', 'Straße'],
    ['Some e\u0301tude music', 'etude', 'e\u0301tude'],
    ['轮胎压力为什么会随温度变化？', '压力', '压力'],
  ]) {
    const { results } = await findPrompts([text], query);
    assert.equal(results.length, 1, query);
    const r = results[0].ranges[0];
    assert.equal(text.slice(r.start, r.end), expected);
  }
});

test('preview uses continuous relevant context and inserts highlight text safely', async () => {
  const text = 'I would like to understand this carefully before making a decision. <img src=x onerror=alert(1)> Please explain battery voltage in winter.';
  const { e, results } = await findPrompts([text], 'voltge');
  const view = new e.probe.TocView(() => {});
  const preview = view.makePreview(results[0].item, results[0].ranges);
  assert.ok(descendantText(preview).includes('voltage'));
  const marks = preview.children.filter(n => n.tag === 'mark');
  assert.equal(marks.map(descendantText).join(''), 'voltage');
  assert.ok(preview.children.every(n => ['span', 'mark'].includes(n.tag)));
  assert.equal(preview.querySelector('.tm-cgpt-toc__search-lead'), null);
  assert.equal(view.makePreview({text:'<script>alarm</script> battery'}, []).textContent, '<script>alarm</script> battery');
});

test('filtering changes only panel contents, preserving full rail mapping, panel height and navigation identity', async () => {
  const e = environment();
  const selected = [];
  const view = new e.probe.TocView(id => selected.push(id));
  const data = items(50).map((item, i) => ({ ...item, text: i === 40 ? 'Battery voltage in winter' : 'Ordinary topic ' + i }));
  view.render(data); view.setActive('p49'); view.setOpen(true); view.setSearchVisible(true);
  const height = view.dock.properties.get('--tm-cgpt-toc-panel-height');
  const rail = view.railList.children.slice();
  await finishQuery(view, e, 'battrey');
  assert.deepEqual(displayedIds(view), ['p40']);
  assert.equal(view.items.length, 50);
  assert.equal(view.railSlot, 14);
  assert.equal(view.railList.children.length, 15);
  assert.ok(rail.every((row, i) => row === view.railList.children[i]));
  assert.equal(view.dock.properties.get('--tm-cgpt-toc-panel-height'), height);
  const button = view.panelById.get('p40').firstElementChild;
  view.dock.events.get('click')[0]({target:button});
  assert.deepEqual(selected, ['p40']);
  assert.equal(view.query, '');
  assert.equal(view.searchVisible, false);
});

test('zero results keep panel geometry, contain wheel events and distinguish incomplete history', async () => {
  const e = environment();
  const view = new e.probe.TocView(() => {});
  view.render(items(20)); view.setOpen(true);
  const height = view.dock.properties.get('--tm-cgpt-toc-panel-height');
  await finishQuery(view,e,'completely unrelated');
  assert.deepEqual(displayedIds(view), []);
  assert.equal(view.emptyNotice.textContent, 'No matching prompts');
  assert.equal(view.dock.properties.get('--tm-cgpt-toc-panel-height'), height);
  let prevented = 0;
  view.onWheel({deltaY:100, deltaMode:0, preventDefault(){prevented++;}});
  assert.equal(prevented, 1);
  view.onWheel({deltaY:100, ctrlKey:true, preventDefault(){prevented++;}});
  assert.equal(prevented, 1, 'Ctrl-wheel should retain browser zoom');
  view.setStatus('loading');
  assert.equal(view.emptyNotice.textContent,'No matches in loaded prompts');
  view.setStatus('complete');
  assert.equal(view.emptyNotice.textContent,'No matching prompts');
});

test('clearing restores independent list position; closing restores default UI on next entry', async () => {
  const e = environment();
  const view = new e.probe.TocView(() => {});
  view.render(items(100)); view.setActive('p50'); view.setOpen(true); view.setSearchVisible(true);
  view.panel.scrollTop = 812;
  await finishQuery(view,e,'Prompt 3');
  view.setQuery('');
  assert.equal(view.panel.scrollTop,812);
  assert.equal(view.entries.length,100);
  await finishQuery(view,e,'Prompt 4');
  view.setOpen(false);
  assert.equal(view.query,'');
  assert.equal(view.searchField.inert,true);
  assert.equal(view.searchField.getAttribute('aria-hidden'),'true');
  assert.equal(view.searchVisible,false);
  view.setOpen(true);
  assert.equal(view.entries.length,100);
  assert.equal(view.panel.scrollTop, 50*46+6+23-167);
});

test('new queries and route clear reject delayed old results even if a dependency ignores cancellation', async () => {
  const e = environment();
  const view = new e.probe.TocView(() => {});
  view.render([{id:'old',text:'battery'}, {id:'new',text:'pressure'}]); view.setOpen(true);
  let resolve;
  view.search.find = () => new Promise(r => {resolve=r;});
  view.setQuery('battery'); view.searchSoon.cancel(); const old = view.runSearch();
  view.setQuery('pressure'); view.searchSoon.cancel();
  resolve([{item:{id:'old',text:'battery'},ranges:[]}]); await old;
  assert.equal(view.query,'pressure');
  assert.equal(view.searchPending,true);
  const pending = view.runSearch();
  view.clear(); resolve([{item:{id:'old',text:'battery'},ranges:[]}]); await pending;
  assert.equal(view.host.hidden,true);
  assert.equal(view.entries.length,0);
  assert.equal(view.query,'');
  assert.equal(e.timers.size,0);
});

test('active search reconciles prepends, new prompts, authoritative edits and removed branches', async () => {
  const e = environment(); const view = new e.probe.TocView(() => {});
  view.render([{id:'a',text:'battery voltage'}]); view.setOpen(true);
  await finishQuery(view,e,'battery');
  view.render([{id:'older',text:'An earlier battery prompt'},{id:'a',text:'Edited pressure prompt'},{id:'b',text:'A new battery prompt'}]);
  view.searchSoon.cancel(); await drive(view.runSearch(),e);
  assert.deepEqual(displayedIds(view),['older','b']);
  assert.equal(view.search.documents.has('a'),true);
  view.render([{id:'a',text:'Edited pressure prompt'}]);
  view.searchSoon.cancel(); await drive(view.runSearch(),e);
  assert.deepEqual(displayedIds(view),[]);
  assert.equal(view.search.documents.has('older'),false);
  assert.equal(view.search.documents.has('b'),false);
});

test('IME input waits for committed text and equivalent input does not restart work', async () => {
  const e = environment(); const view = new e.probe.TocView(() => {});
  view.render([{id:'a',text:'轮胎压力'}]); view.setOpen(true);
  view.searchInput.events.get('compositionstart')[0]();
  view.searchInput.value = '压';
  view.searchInput.events.get('input')[0]({isComposing:true});
  assert.equal(view.query,'');
  view.searchInput.value = '压力';
  view.searchInput.events.get('compositionend')[0]();
  assert.equal(view.query,'压力');
  const sequence = view.searchSequence;
  view.searchInput.events.get('input')[0]({isComposing:false});
  assert.equal(view.searchSequence,sequence);
  view.searchSoon.cancel(); await drive(view.runSearch(),e);
  assert.deepEqual(displayedIds(view),['a']);
});

test('intentional search hover readies typing while ordinary TOC hover keeps composer focus', async () => {
  const e = environment(); const view = new e.probe.TocView(() => {});
  view.render([{id:'a',text:'battery'},{id:'b',text:'pressure'}]); view.setOpen(true);
  const composer = new e.Element('textarea'); composer.focus();
  view.dock.events.get('pointerenter')[0]();
  assert.equal(e.focused().element,composer);
  view.searchButton.events.get('pointerenter')[0]();
  assert.equal(view.searchVisible,true);
  assert.equal(e.focused().element,view.searchInput);
  view.searchButton.events.get('click')[0]();
  assert.equal(e.focused().element,view.searchInput);
  await finishQuery(view,e,'pressure');
  const event = {target:view.searchInput,key:'ArrowDown',preventDefault(){},stopPropagation(){}};
  view.dock.events.get('keydown')[0](event);
  assert.equal(e.focused().element.dataset.messageId,'b');
  view.dock.events.get('keydown')[0]({...event,key:'Escape'});
  assert.equal(view.query,'');
  assert.equal(view.open,true);
  assert.equal(e.focused().element,view.searchInput);
  view.dock.events.get('keydown')[0]({...event,key:'Escape'});
  assert.equal(view.open,false);
});

test('destroy cancels a debounced search and releases its lazy index', async () => {
  const e = environment(); const view = new e.probe.TocView(() => {});
  view.render([{id:'a',text:'battery'}]); view.setOpen(true);
  await finishQuery(view,e,'battery');
  assert.equal(view.search.documents.size,1);
  view.setQuery('pressure');
  assert.equal(e.timers.size,1);
  view.destroy();
  assert.equal(e.timers.size,0);
  assert.equal(view.search.documents.size,0);
  assert.equal(view.entries.length,0);
});

test('partial remembered words work in every query position, not only the last term', async () => {
  assert.deepEqual((await findPrompts(['A battery voltage question','An unrelated volleyball question'], 'batt volt')).results.map(r=>r.item.id), ['0']);
});

test('cancellation checkpoints apply inside one huge prompt and incomplete indexing is not cached', async () => {
  const e = environment();
  let ticks = 0;
  e.context.performance = {now:()=>++ticks};
  const search = new e.probe.PromptSearch();
  search.setItems([{id:'huge',text:'ordinary material '.repeat(20000)+'battery voltage'}]);
  const controller = new AbortController();
  const pending = search.find('battery',controller.signal);
  assert.ok(e.timers.size > 0, 'one long prompt did not yield during indexing');
  controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(e.timers.size,0);
  assert.equal(search.documents.size,0);
  const result = await drive(search.find('battrey voltge'), e);
  assert.equal(result.length,1);
  assert.equal(result[0].item.id,'huge');
  assert.equal(search.documents.size,1);
});

test('unexpected search failure is truthful and clearing/retrying restores normal operation', async () => {
  const e = environment();
  let diagnostics = 0;
  e.context.console = {warn(){diagnostics++;}};
  const view = new e.probe.TocView(() => {});
  view.render([{id:'a',text:'battery'},{id:'b',text:'pressure'}]); view.setOpen(true);
  const original = view.search.find.bind(view.search);
  view.search.find = async () => {throw new TypeError('fixture failure');};
  await finishQuery(view,e,'battery');
  assert.equal(view.emptyNotice.textContent,'Search unavailable');
  assert.equal(view.searchPending,false);
  assert.equal(diagnostics,1);
  view.setQuery('');
  assert.deepEqual(displayedIds(view),['a','b']);
  view.search.find = original;
  await finishQuery(view,e,'battery');
  assert.deepEqual(displayedIds(view),['a']);
  assert.equal(view.searchError,false);
});

test('search pending results cannot activate an old prompt and no search operation sends a network request', async () => {
  const e = environment(); let navigations=0;
  const view = new e.probe.TocView(()=>navigations++);
  view.render([{id:'a',text:'battery'},{id:'b',text:'pressure'}]); view.setOpen(true);
  const oldButton = view.panelById.get('a').firstElementChild;
  view.setQuery('pressure');
  assert.equal(view.panelList.getAttribute('aria-busy'),'true');
  view.dock.events.get('click')[0]({target:oldButton});
  assert.equal(navigations,0);
  view.searchSoon.cancel(); await drive(view.runSearch(),e);
  assert.equal(view.panelList.getAttribute('aria-busy'),'false');
  assert.deepEqual(displayedIds(view),['b']);
  assert.equal(e.timers.size,0);
});

test('typed literal prefixes match from two characters with no word-length ratio gate', async () => {
  for (const [word, sequence] of [
    ['text',['te','tex','text']],
    ['magnification',['ma','mag','magn','magni','magnif','magnifi','magnific','magnifica','magnificat','magnificati','magnificatio','magnification']],
    ['international',['in','int','inte','inter','intern','interna','internat','internati','internatio','internation','internationa','international']],
  ]) for (const prefix of sequence) {
    assert.deepEqual((await findPrompts(['Discuss '+word,'Entirely unrelated reading'],prefix)).results.map(r=>r.item.id),['0'],prefix);
  }
});

test('numeric and letter prefixes remain matched across ignored quote and space boundaries', async () => {
  for (const text of ['roughly a size 32” DDD','roughly a size 32\u2033\u00a0DDD','roughly a size 32 DDD','roughly a size 32DDD','roughly a size 32-ddd']) {
    for (const query of ['32','32d','32dd','32ddd','32 d','32 dd','32 ddd']) {
      assert.deepEqual((await findPrompts([text,'roughly a size 34 DDD'],query)).results.map(r=>r.item.id),['0'],text+' / '+query);
    }
  }
});

test('multi-term partial words work in either order and stay matched as the last term starts', async () => {
  for (const query of ['ba vo','batt v','batt vo','batt vol','battery volt','vo ba']) {
    assert.deepEqual((await findPrompts(['Battery voltage in winter','A battery warranty question','Volleyball shoes'],query)).results.map(r=>r.item.id),['0'],query);
  }
});

test('one-character input keeps the full default list without building a search index', async () => {
  for (const query of ['t','3','é','压','!']) {
    const {results,search} = await findPrompts(['text','Battery voltage'],query);
    assert.deepEqual(results.map(r=>r.item.id),['0','1'],query);
    assert.ok(results.every(r=>r.ranges.length===0));
    assert.equal(search.documents.size,0);
  }
});


function fireCloseTimer(view,e) {
  const fn=e.timers.get(view.closeTimer);
  assert.ok(fn,'expected an owned close-delay timer');
  e.window.clearTimeout(view.closeTimer);
  fn();
}

test('an unused hover-focused search closes on leaving and restores the prior composer without scrolling', () => {
  const e=environment(); const view=new e.probe.TocView(()=>{});
  const composer=new e.Element('textarea'); composer.focus();
  view.render(items(20));
  view.dock.events.get('pointerenter')[0]();
  view.searchButton.events.get('pointerenter')[0]();
  assert.equal(e.focused().element,view.searchInput);
  assert.equal(e.focused().options.preventScroll,true);
  view.dock.events.get('pointerleave')[0]();
  fireCloseTimer(view,e);
  assert.equal(view.open,false);
  assert.equal(e.focused().element,composer);
  assert.equal(e.focused().options.preventScroll,true);
  assert.equal(view.hoverFocus,null);
  assert.equal(e.timers.size,0);
});

test('typing engages search so leaving the hover region does not interrupt it; external focus can close it', async () => {
  const e=environment(); const view=new e.probe.TocView(()=>{});
  view.render([{id:'a',text:'text preview'},{id:'b',text:'battery'}]);
  view.dock.events.get('pointerenter')[0]();
  view.searchButton.events.get('pointerenter')[0]();
  view.searchInput.value='te';
  view.searchInput.events.get('input')[0]({isComposing:false});
  view.searchSoon.cancel(); await drive(view.runSearch(),e);
  assert.equal(view.hoverFocus,null);
  view.dock.events.get('pointerleave')[0](); fireCloseTimer(view,e);
  assert.equal(view.open,true);
  assert.deepEqual(displayedIds(view),['a']);
  const outside=new e.Element('textarea'); outside.focus();
  view.dock.events.get('focusout')[0]({relatedTarget:outside}); fireCloseTimer(view,e);
  assert.equal(view.open,false);
  assert.equal(e.focused().element,outside);
  assert.equal(view.query,'');
});

test('reentering the shared hover region cancels closure; Escape returns an unused hover focus', () => {
  const e=environment(); const view=new e.probe.TocView(()=>{});
  const composer=new e.Element('textarea'); composer.focus();
  view.render(items(20)); view.dock.events.get('pointerenter')[0]();
  view.searchButton.events.get('pointerenter')[0]();
  view.dock.events.get('pointerleave')[0]();
  view.dock.events.get('pointerenter')[0]();
  assert.equal(e.timers.size,0);
  assert.equal(view.open,true);
  view.dock.events.get('keydown')[0]({target:view.searchInput,key:'Escape',preventDefault(){},stopPropagation(){}});
  assert.equal(view.open,false);
  assert.equal(e.focused().element,composer);
  assert.equal(view.hoverFocus,null);
});

test('clearing or destroying a hover-focused view releases focus ownership and retained nodes', () => {
  for(const action of ['clear','destroy']) {
    const e=environment(); const view=new e.probe.TocView(()=>{});
    const composer=new e.Element('textarea'); composer.focus();
    view.render(items(20)); view.dock.events.get('pointerenter')[0]();
    view.searchButton.events.get('pointerenter')[0]();
    view[action]();
    assert.equal(e.focused().element,composer,action);
    assert.equal(view.hoverFocus,null,action);
    assert.equal(e.timers.size,0,action);
  }
});

test('one-character input keeps current panel nodes and reading-centered scroll; backspacing restores browsing position', async () => {
  const e=environment(); const view=new e.probe.TocView(()=>{});
  view.render(items(100)); view.setActive('p50'); view.setOpen(true);
  const first=view.panelList.firstElementChild;
  const scroll=view.panel.scrollTop;
  view.setQuery('p');
  assert.equal(view.searchPending,false);
  assert.equal(view.panelList.firstElementChild,first);
  assert.equal(view.panel.scrollTop,scroll);
  assert.equal(e.timers.size,0);
  await finishQuery(view,e,'Prompt 3');
  view.setQuery('p');
  assert.equal(view.entries.length,100);
  assert.equal(view.panel.scrollTop,scroll);
  assert.equal(view.searchPending,false);
});

test('progressive literal matching maps highlighted original characters across normalization and separators', async () => {
  for(const [text,query,expected] of [
    ['Some TEXT here','te','TE'],
    ['Original 32” DDD detail','32d','32” D'],
    ['Original 32” DDD detail','32dd','32” DD'],
    ['A CAFÉ example','ca','CA'],
    ['An e\u0301tude example','et','e\u0301t'],
    ['A ﬁle example','fi','ﬁ'],
    ['A Straße example','stras','Straß'],
  ]) {
    const {results}=await findPrompts([text],query);
    assert.equal(results.length,1,query);
    const range=results[0].ranges[0];
    assert.equal(text.slice(range.start,range.end),expected,query);
  }
});

test('literal prefix evidence beats a fuzzy word when both are available for a term', async () => {
  const text='Can you explain the fairly commonplace change in chromatography and carrier charging performance?';
  const {results}=await findPrompts([text],'charg perf');
  assert.equal(results.length,1);
  const sourceMatches=results[0].ranges.map(r=>text.slice(r.start,r.end));
  assert.ok(sourceMatches.includes('charg'));
  assert.ok(sourceMatches.includes('perf'));
  assert.ok(!sourceMatches.includes('change'));
});

test('actual input-handler sequences keep target rows continuously available while typing and backspacing', async () => {
  for(const [target,sequence] of [
    ['The text within the panel needs work',['t','te','tex','text','tex','te','t','']],
    ['A sizing question, roughly a size 32” DDD',['3','32','32d','32dd','32ddd','32dd','32d','32','3','']],
  ]) {
    const e=environment();const view=new e.probe.TocView(()=>{});
    view.render([{id:'target',text:target},{id:'other',text:'Unrelated topic'}]);
    view.setActive('target');view.setOpen(true);view.setSearchVisible(true);
    const height=view.dock.properties.get('--tm-cgpt-toc-panel-height');
    for(const value of sequence) {
      view.searchInput.value=value;
      view.searchInput.events.get('input')[0]({isComposing:false});
      if(view.searchPending) {view.searchSoon.cancel();await drive(view.runSearch(),e);}
      const ids=displayedIds(view);
      assert.equal(ids.filter(id=>id==='target').length,1,value);
      assert.equal(view.panelById.get('target').firstElementChild.getAttribute('aria-label'),target);
      assert.equal(view.dock.properties.get('--tm-cgpt-toc-panel-height'),height,value);
      assert.equal(view.railList.children.length,2,value);
      assert.equal(view.searchPending,false,value);
    }
  }
});

test('nearby search hits read as one continuous source preview without duplicated opening words', async () => {
  const text='ok 1. let’s do a full robustness/standards check with the now standardized md, and retain all intended functionality.';
  const {e,results}=await findPrompts([text],'robustness');
  const view=new e.probe.TocView(()=>{});
  const preview=view.makePreview(results[0].item,results[0].ranges);
  const shown=descendantText(preview);
  assert.ok(shown.startsWith('ok 1. let’s do a full robustness/standards check'),shown);
  assert.equal((shown.match(/full/g)||[]).length,1);
  assert.equal(shown.includes('…'),false,'short source text needs no manufactured omission');
  assert.equal(preview.querySelector('.tm-cgpt-toc__search-lead'),null);
});

test('unused search retracts when leaving its own area while the contents panel stays open', () => {
  const e=environment();const view=new e.probe.TocView(()=>{});
  view.render(items(20));view.dock.events.get('pointerenter')[0]();
  view.searchButton.events.get('pointerenter')[0]();
  assert.equal(view.searchVisible,true);
  const leave=view.searchShelf.events.get('pointerleave')?.[0];
  assert.equal(typeof leave,'function','search needs its own hover lifecycle');
  leave();
  const fn=e.timers.get(view.searchRetractTimer);
  assert.ok(fn,'empty search should schedule its own retraction');
  e.window.clearTimeout(view.searchRetractTimer);fn();
  assert.equal(view.searchVisible,false);
  assert.equal(view.open,true);
});

const monoMetrics = (width) => ({width, measure: (value) => Array.from(value).length * 7});

function matchRanges(text, terms) {
  return terms.map(term=>({start:text.indexOf(term),end:text.indexOf(term)+term.length})).sort((a,b)=>a.start-b.start);
}

function fireRetraction(view,e) {
  const fn=e.timers.get(view.searchRetractTimer);
  assert.ok(fn,'expected a search retraction timer');
  e.window.clearTimeout(view.searchRetractTimer);fn();
}

test('short and beginning-hit previews retain one intact source run without invented omissions', () => {
  const e=environment();
  for(const text of ['Robustness first.','A quick robustness check.','ok 1. let’s do a full robustness/standards check.']) {
    const result=e.probe.searchPreview(text,matchRanges(text,['robustness'].map(x=>text.startsWith('R')?'Robustness':x)),monoMetrics(292));
    assert.equal(result.start,0,text);
    assert.equal(result.end,text.length,text);
  }
});

test('excerpt selection adapts to width, and distant hits do not spend a line on unrelated opening text', () => {
  const e=environment();
  const text='Before making a practical decision, can you explain the robustness of this design in ordinary language?';
  const ranges=matchRanges(text,['robustness']);
  const broad=e.probe.searchPreview(text,ranges,monoMetrics(360));
  const narrow=e.probe.searchPreview(text,ranges,monoMetrics(140));
  assert.equal(broad.start,0);
  assert.ok(narrow.start>0);
  assert.ok(narrow.start<=ranges[0].start && narrow.end>=ranges[0].end);
  const late='An unrelated introduction. '+('ordinary discussion '.repeat(300))+'The overall robustness stays useful under UI changes.';
  const selected=e.probe.searchPreview(late,matchRanges(late,['robustness']),monoMetrics(292));
  assert.ok(selected.start>5000);
  assert.ok(late.slice(selected.start,selected.end).includes('robustness stays useful'));
});

test('preview favors a useful nearby cluster of search terms while retaining all source text in the model', () => {
  const e=environment();
  const text='Battery appears at the beginning. '+('unrelated filler '.repeat(80))+'Voltage and charging are explained together at the end.';
  const ranges=matchRanges(text,['Battery','Voltage','charging']);
  const selected=e.probe.searchPreview(text,ranges,monoMetrics(292));
  const shown=text.slice(selected.start,selected.end);
  assert.ok(shown.includes('Voltage and charging'));
  assert.ok(!shown.includes('Battery appears at the beginning'));
  const view=new e.probe.TocView(()=>{});
  view.render([{id:'same-id',text}]);
  view.renderPanelEntries([{item:{id:'same-id',text},ranges}]);
  assert.equal(view.items[0].text,text);
  assert.equal(view.panelById.get('same-id').firstElementChild.getAttribute('aria-label'),text);
});

test('unbroken and Unicode excerpts retain the hit without splitting a grapheme at the display boundary', () => {
  const e=environment();
  const long='robustness'+('x'.repeat(1000));
  const selected=e.probe.searchPreview(long,matchRanges(long,['robustness']),monoMetrics(120));
  assert.equal(selected.start,0);
  assert.ok(selected.end>10 && selected.end<long.length);
  const text='robustness '+('a'.repeat(497))+'👩‍💻'+('x'.repeat(100));
  const part=e.probe.searchPreview(text,matchRanges(text,['robustness']),monoMetrics(292));
  const boundaries=new Set(Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text),p=>p.index));
  boundaries.add(text.length);
  assert.ok(boundaries.has(part.end),'preview ended inside a Unicode grapheme');
});

test('empty mouse-clicked search still retracts, and rapid re-entry cancels that retraction', () => {
  const e=environment();const view=new e.probe.TocView(()=>{});
  view.render(items(20));view.dock.events.get('pointerenter')[0]();
  view.searchButton.events.get('pointerenter')[0]();
  view.searchField.events.get('pointerdown')[0]();
  assert.equal(view.searchSessionStarted,false);
  view.searchShelf.events.get('pointerleave')[0]();
  assert.ok(view.searchRetractTimer);
  view.searchShelf.events.get('pointerenter')[0]();
  assert.equal(view.searchRetractTimer,0);
  assert.equal(view.searchVisible,true);
  view.searchShelf.events.get('pointerleave')[0]();fireRetraction(view,e);
  assert.equal(view.searchVisible,false);
  assert.equal(view.searchField.inert,true);
  assert.equal(view.open,true);
});

test('typing pins search for this panel session, including a cleared query; closing resets the session', async () => {
  const e=environment();const view=new e.probe.TocView(()=>{});
  view.render([{id:'a',text:'robustness check'},{id:'b',text:'other'}]);
  view.dock.events.get('pointerenter')[0]();view.searchButton.events.get('pointerenter')[0]();
  view.searchInput.value='ro';view.searchInput.events.get('input')[0]({isComposing:false});
  view.searchSoon.cancel();await drive(view.runSearch(),e);
  view.searchShelf.events.get('pointerleave')[0]();
  assert.equal(view.searchRetractTimer,0);
  assert.equal(view.searchVisible,true);
  view.clearButton.events.get('click')[0]();
  assert.equal(view.query,'');
  assert.equal(view.searchSessionStarted,true);
  view.searchShelf.events.get('pointerleave')[0]();
  assert.equal(view.searchRetractTimer,0);
  assert.equal(view.searchVisible,true);
  view.setOpen(false);
  assert.equal(view.searchSessionStarted,false);
  assert.equal(view.searchVisible,false);
  view.setOpen(true);view.searchButton.events.get('pointerenter')[0]();
  view.searchShelf.events.get('pointerleave')[0]();fireRetraction(view,e);
  assert.equal(view.searchVisible,false);
});

test('composition and explicit keyboard activation keep search usable independently of the mouse', () => {
  for(const mode of ['keyboard','composition']) {
    const e=environment();const view=new e.probe.TocView(()=>{});
    view.render(items(20));view.setOpen(true);
    if(mode==='keyboard')view.searchButton.events.get('click')[0]({detail:0});
    else {view.searchButton.events.get('pointerenter')[0]();view.searchInput.events.get('compositionstart')[0]();}
    view.searchShelf.events.get('pointerleave')[0]();
    if(view.searchRetractTimer)fireRetraction(view,e);
    assert.equal(view.searchVisible,true,mode);
    assert.equal(e.focused().element,view.searchInput,mode);
    assert.equal(view.searchField.inert,false,mode);
  }
});

test('an unused keyboard field retracts after focus returns to the prompt list', () => {
  const e=environment();const view=new e.probe.TocView(()=>{});
  view.render(items(20));view.dock.events.get('pointerenter')[0]();
  view.searchButton.events.get('click')[0]({detail:0});
  view.searchShelf.events.get('pointerleave')[0]();fireRetraction(view,e);
  assert.equal(view.searchVisible,true,'keep explicit keyboard focus usable');
  const prompt=view.panelList.firstElementChild.firstElementChild;
  prompt.focus({preventScroll:true});
  const focusout=view.searchField.events.get('focusout')?.[0];
  assert.equal(typeof focusout,'function','unused search needs to follow focus leaving its field');
  focusout({relatedTarget:prompt});fireRetraction(view,e);
  assert.equal(view.searchVisible,false);
  assert.equal(view.open,true);
  assert.equal(e.focused().element,prompt);
});

test('preview width honors valid zero padding instead of applying a missing-value fallback', () => {
  const e=environment();const view=new e.probe.TocView(()=>{});
  view.panel.clientWidth=300;
  e.context.getComputedStyle=element=>element===view.previewProbe
    ? {paddingLeft:'0px',paddingRight:'0px'}
    : {fontSize:'14px',fontWeight:'400',fontFamily:'sans-serif',letterSpacing:'normal'};
  assert.equal(view.previewMetrics().width,300-2*e.probe.CONFIG.panelPaddingPx);
});

test('blur-triggered focusout cannot recreate a retraction timer during hiding or teardown', () => {
  for(const action of ['hide','destroy']) {
    const e=environment();const view=new e.probe.TocView(()=>{});
    view.render(items(20));view.setOpen(true);view.searchButton.events.get('pointerenter')[0]();
    view.pointerInSearch=false;
    const blur=view.searchInput.blur.bind(view.searchInput);
    view.searchInput.blur=()=>{
      blur();
      view.searchField.events.get('focusout')[0]({relatedTarget:null});
    };
    if(action==='hide')view.setSearchVisible(false);
    else view.destroy();
    assert.equal(view.searchRetractTimer,0,action);
    assert.equal(e.timers.size,0,action);
  }
});

test('retracting an unused field restores outside focus without moving the panel scroll position', () => {
  const e=environment();const view=new e.probe.TocView(()=>{});
  const composer=new e.Element('textarea');composer.focus();
  view.render(items(100));view.setActive('p50');view.dock.events.get('pointerenter')[0]();
  const scroll=view.panel.scrollTop;
  view.searchButton.events.get('pointerenter')[0]();
  view.searchShelf.events.get('pointerleave')[0]();fireRetraction(view,e);
  assert.equal(e.focused().element,composer);
  assert.equal(e.focused().options.preventScroll,true);
  assert.equal(view.panel.scrollTop,scroll);
  assert.equal(view.open,true);
});

test('resize refreshes only preview spans, keeping prompt buttons, focus and independent scroll', async () => {
  const e=environment();const view=new e.probe.TocView(()=>{});
  view.render([{id:'a',text:'Before making a practical decision, can you explain the robustness of this design in ordinary language?'},{id:'b',text:'other'}]);
  view.setOpen(true);view.setSearchVisible(true);
  await finishQuery(view,e,'robustness');
  const button=view.panelById.get('a').firstElementChild;
  const preview=button.firstElementChild;
  button.focus();view.panel.scrollTop=21;
  let measurements=0;
  view.previewMetrics=()=>{measurements++;return monoMetrics(140);};
  view.resize();
  assert.equal(button.firstElementChild,preview);
  const timer=Array.from(e.timers).find(([id])=>e.timerDelays.get(id)===e.probe.SEARCH.previewResizeDelayMs);
  assert.ok(timer);e.window.clearTimeout(timer[0]);timer[1]();
  assert.equal(measurements,1);
  assert.equal(view.panelById.get('a').firstElementChild,button);
  assert.notEqual(button.firstElementChild,preview);
  assert.equal(e.focused().element,button);
  assert.equal(view.panel.scrollTop,21);
});

test('font readiness subscription and new UI timers are owned and released on teardown', () => {
  const e=environment();const callbacks=new Set();
  e.document.fonts={addEventListener(_name,fn){callbacks.add(fn);},removeEventListener(_name,fn){callbacks.delete(fn);}};
  const view=new e.probe.TocView(()=>{});
  assert.equal(callbacks.size,1);
  view.render(items(20));view.setOpen(true);view.searchButton.events.get('pointerenter')[0]();
  view.searchShelf.events.get('pointerleave')[0]();
  view.setQuery('Prompt');view.resize();
  assert.ok(e.timers.size>=2);
  view.destroy();
  assert.equal(callbacks.size,0);
  assert.equal(e.timers.size,0);
  assert.equal(view.previewContext,null);
});

test('font measurement reuse distinguishes highlights and does not cross render/font contexts', () => {
  const {probe}=environment();let calls=0;
  const first=probe.cachedPreviewMeasure((text,highlighted)=>{calls++;return text.length*(highlighted?9:7);});
  assert.equal(first('term'),28);
  assert.equal(first('term',true),36);
  assert.equal(first('term'),28);
  assert.equal(first('term',true),36);
  assert.equal(calls,2);
  const next=probe.cachedPreviewMeasure(text=>text.length*11);
  assert.equal(next('term'),44);
  assert.equal(first('term'),28);
});
