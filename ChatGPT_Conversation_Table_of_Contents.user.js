// ==UserScript==
// @name         ChatGPT Conversation Table of Contents
// @namespace    https://github.com/TacticalOriental/ChatGPT_Conversation_Table_of_Contents
// @version      2.1.3
// @description  Native-style prompt navigation for ChatGPT, with optional typo-tolerant search.
// @author       TacticalOriental
// @license      MIT
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// @supportURL   https://github.com/TacticalOriental/ChatGPT_Conversation_Table_of_Contents/issues
// @homepageURL  https://github.com/TacticalOriental/ChatGPT_Conversation_Table_of_Contents
// ==/UserScript==

(function () {
  'use strict';

  const NS = 'tm-cgpt-toc';

  // ---------------------------------------------------------------------------
  // Easy visual and behavioral tuning
  // ---------------------------------------------------------------------------
  const CONFIG = Object.freeze({
    panelWidthPx: 320,
    panelVisibleRows: 7,
    railHitWidthPx: 34,
    rightOffsetCss: 'clamp(16px, 1.5vw, 24px)',
    triggerMinHeightPx: 34,
    railLineLimit: 15,
    railLineWidthPx: 22,
    railLineHeightPx: 2.5,
    railRowHeightPx: 10,
    panelRowHeightPx: 46,
    railPaddingPx: 3,
    panelPaddingPx: 6,
    promptFontSizePx: 14,
    transitionMs: 150,
    closeDelayMs: 145,
    navigationTopOffsetPx: 76,
    bottomSnapPx: 64,
    domReconcileDelayMs: 80,
    dataRefreshDelayMs: 900,
    apiPageSizeTurns: 100,
    apiYieldEveryPages: 20,
    requestTimeoutMs: 20_000,
    requestMaxAttempts: 3,
    retryBaseDelayMs: 600,
    retryMaxDelayMs: 10_000,
    recoveryCooldownMs: 30_000,
    cacheConversationLimit: 8,
  });

  // Current semantic hooks are centralized here so a future ChatGPT markup
  // change can be repaired without touching the rest of the script.
  const SELECTOR = Object.freeze({
    turn: '[data-turn-key]',
    userSearchUnit: '[data-chatgpt-search-unit-key$=":user"]',
    userContentUnit: '[data-content-search-unit-key$=":user"]',
    messageIds: '[data-chatgpt-search-message-ids]',
    userBubble: '[data-user-message-bubble="true"]',
    promptText: '[data-search-result-target]',
    threadScroller: '.thread-scroll-container',
  });
  const USER_UNIT_SELECTOR = `${SELECTOR.userSearchUnit},${SELECTOR.userContentUnit}`;

  const ROUTE_EVENT = `${NS}:route-change`;
  const HISTORY_PATCH = Symbol.for(`${NS}.history-patched`);
  const INSTANCE_KEY = Symbol.for(`${NS}.instance`);
  const PENDING_NAVIGATION_KEY = `${NS}:pending-navigation`;

  function normalizeText(value) {
    return String(value ?? '')
      .replace(/[\u200B\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function createDebouncer(callback, delay) {
    let timer = 0;
    const schedule = (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => callback(...args), delay);
    };
    schedule.cancel = () => {
      window.clearTimeout(timer);
      timer = 0;
    };
    return schedule;
  }

  function isAbortError(error) {
    return error?.name === 'AbortError';
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError');
  }

  function cancellableDelay(delayMs, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const cancel = () => {
        window.clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        reject(new DOMException('Operation cancelled', 'AbortError'));
      };
      const timer = window.setTimeout(() => {
        signal?.removeEventListener('abort', cancel);
        resolve();
      }, delayMs);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  function readPendingNavigation() {
    try {
      const value = JSON.parse(sessionStorage.getItem(PENDING_NAVIGATION_KEY));
      if (
        typeof value?.conversationId === 'string'
        && typeof value?.messageId === 'string'
        && Number.isFinite(value?.expiresAt)
        && value.expiresAt > Date.now()
      ) {
        return value;
      }
    } catch {
      // Ignore malformed or unavailable session storage.
    }
    try { sessionStorage.removeItem(PENDING_NAVIGATION_KEY); } catch {}
    return null;
  }

  function rememberPendingNavigation(context, messageId) {
    try {
      sessionStorage.setItem(PENDING_NAVIGATION_KEY, JSON.stringify({
        conversationId: context.conversationId,
        messageId,
        expiresAt: Date.now() + 30_000,
      }));
    } catch {
      // Native targeting remains functional even if storage is unavailable.
    }
  }

  function forgetPendingNavigation() {
    try { sessionStorage.removeItem(PENDING_NAVIGATION_KEY); } catch {}
  }

  function routeContext() {
    const parts = location.pathname.split('/').filter(Boolean);
    const conversationIndex = parts.lastIndexOf('c');
    const conversationId = conversationIndex >= 0 ? parts[conversationIndex + 1] : '';

    if (!conversationId || !/^[a-z0-9_-]{12,}$/i.test(conversationId)) {
      return null;
    }

    const projectIndex = parts.indexOf('g');
    const projectSegment = projectIndex >= 0 ? parts[projectIndex + 1] ?? '' : '';
    const projectId = projectSegment.match(/^(g-p-[a-f0-9]+)/i)?.[1] ?? null;
    const search = new URLSearchParams(location.search);
    const ownerId = search.get('owner_user_id') ?? search.get('conversation_owner_id');

    return Object.freeze({
      conversationId,
      projectId,
      ownerId,
      key: `${projectId ?? 'personal'}:${ownerId ?? 'self'}:${conversationId}`,
    });
  }

  function patchHistoryEvents() {
    if (history[HISTORY_PATCH]) return;

    try {
      Object.defineProperty(history, HISTORY_PATCH, { value: true });
      for (const method of ['pushState', 'replaceState']) {
        const original = history[method];
        history[method] = function (...args) {
          const result = original.apply(this, args);
          window.dispatchEvent(new Event(ROUTE_EVENT));
          return result;
        };
      }
    } catch {
      // The DOM observer and popstate listener still cover route changes if a
      // future browser makes History methods non-writable.
    }
  }

  class HttpError extends Error {
    constructor(status, url, retryAfterMs = 0) {
      super(`ChatGPT request failed (${status})`);
      this.name = 'HttpError';
      this.status = status;
      this.url = url;
      this.retryAfterMs = retryAfterMs;
    }
  }

  class RequestTimeoutError extends Error {
    constructor() {
      super('ChatGPT read timed out');
      this.name = 'RequestTimeoutError';
    }
  }

  class ConversationDataError extends Error {
    constructor(message) {
      super(message);
      this.name = 'ConversationDataError';
    }
  }

  class ConversationLoadError extends Error {
    constructor(cause, checkpoint) {
      super(cause.message, { cause });
      this.name = 'ConversationLoadError';
      this.checkpoint = checkpoint;
    }
  }

  function isTransientError(error) {
    if (error instanceof ConversationLoadError) return isTransientError(error.cause);
    return error instanceof RequestTimeoutError
      || error instanceof TypeError // fetch's network failure, not a schema failure
      || (error instanceof HttpError && [408, 429, 500, 502, 503, 504].includes(error.status));
  }

  // Reads the same short-lived token already delivered to the signed-in page.
  // It is kept only in memory and is never stored by this userscript.
  class ChatGPTRequest {
    constructor() {
      this.token = null;
    }

    tokenFromBootstrap() {
      try {
        const script = document.getElementById('client-bootstrap');
        const data = script?.textContent ? JSON.parse(script.textContent) : null;
        return typeof data?.session?.accessToken === 'string'
          ? data.session.accessToken
          : null;
      } catch {
        return null;
      }
    }

    async refreshToken(signal) {
      const session = await this.readJson('/api/auth/session', {
        headers: { Accept: 'application/json' }, signal,
      });
      this.token = typeof session?.accessToken === 'string' ? session.accessToken : null;
      return this.token;
    }

    async getToken(signal, forceRefresh = false) {
      if (!forceRefresh) {
        this.token ||= this.tokenFromBootstrap();
        if (this.token) return this.token;
      }
      return this.refreshToken(signal);
    }

    async json(path, { headers = {}, signal } = {}) {
      const outgoing = new Headers(headers);
      outgoing.set('Accept', 'application/json');
      const token = await this.getToken(signal);
      if (token) outgoing.set('Authorization', `Bearer ${token}`);
      try {
        return await this.readJson(path, { headers: outgoing, signal });
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 401) throw error;
        // Exactly one authentication refresh; never a reauthentication loop.
        const refreshed = await this.getToken(signal, true);
        if (refreshed) outgoing.set('Authorization', `Bearer ${refreshed}`);
        else outgoing.delete('Authorization');
        return this.readJson(path, { headers: outgoing, signal });
      }
    }

    async readJson(path, { headers, signal }) {
      // This is the only automatic transient-retry owner. A failed older page
      // retries here, without fetching successful pages again.
      for (let attempt = 0; attempt < CONFIG.requestMaxAttempts; attempt += 1) {
        throwIfAborted(signal);
        try {
          return await this.readAttempt(path, headers, signal);
        } catch (error) {
          throwIfAborted(signal);
          if (!isTransientError(error) || attempt + 1 === CONFIG.requestMaxAttempts) throw error;
          const backoff = Math.min(
            CONFIG.retryMaxDelayMs,
            CONFIG.retryBaseDelayMs * 2 ** attempt * (0.8 + Math.random() * 0.4),
          );
          const retryAfter = error.retryAfterMs ?? 0;
          // Do not retry earlier than a long server-requested wait, or keep a
          // background timer alive for it. A later user/online event can resume.
          if (retryAfter > CONFIG.retryMaxDelayMs) throw error;
          await cancellableDelay(Math.max(backoff, retryAfter), signal);
        }
      }
    }

    async readAttempt(path, headers, signal) {
      if (!path.startsWith('/') || path.startsWith('//')) {
        throw new ConversationDataError('Only same-origin ChatGPT reads are supported');
      }
      throwIfAborted(signal);
      const controller = new AbortController();
      let rejectCancellation;
      const cancelled = new Promise((_, reject) => { rejectCancellation = reject; });
      const cancel = () => {
        rejectCancellation(new DOMException('Operation cancelled', 'AbortError'));
        controller.abort();
      };
      signal?.addEventListener('abort', cancel, { once: true });
      let timer = 0;
      let completed = false;
      try {
        // The deadline includes response-body decoding. Promise.race also
        // settles if an intercepted fetch implementation ignores AbortSignal.
        const deadline = new Promise((_, reject) => {
          timer = window.setTimeout(() => {
            reject(new RequestTimeoutError());
            controller.abort();
          }, CONFIG.requestTimeoutMs);
        });
        const read = async () => {
          const response = await fetch(path, {
            method: 'GET', credentials: 'include', cache: 'no-store',
            headers, signal: controller.signal,
          });
          if (!response.ok) {
            const guidance = response.headers?.get('Retry-After');
            const seconds = guidance == null ? NaN : Number(guidance);
            const retryAfterMs = Number.isFinite(seconds)
              ? Math.max(0, seconds * 1000)
              : Math.max(0, (Date.parse(guidance) || 0) - Date.now());
            throw new HttpError(response.status, response.url, retryAfterMs);
          }
          return response.json();
        };
        const result = await Promise.race([read(), deadline, cancelled]);
        completed = true;
        return result;
      } finally {
        window.clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (!completed) controller.abort();
      }
    }
  }

  function collectPromptText(message) {
    const content = message?.content;
    const pieces = [];

    const addPart = (part) => {
      if (typeof part === 'string') {
        pieces.push(part);
        return;
      }
      if (!part || typeof part !== 'object') return;

      // Deliberately accept only explicitly textual multimodal parts. This
      // excludes image pointers, file metadata, attachment names and controls.
      const kind = String(part.content_type ?? part.type ?? '').toLowerCase();
      if ((kind === 'text' || kind === 'input_text') && typeof part.text === 'string') {
        pieces.push(part.text);
      }
    };

    if (Array.isArray(content?.parts)) content.parts.forEach(addPart);
    else if (typeof content?.text === 'string') pieces.push(content.text);
    else if (typeof content === 'string') pieces.push(content);

    if (!pieces.length && typeof content?.transcript === 'string') {
      pieces.push(content.transcript);
    }

    return normalizeText(pieces.join(' '));
  }

  function messageFromRecord(record) {
    return record?.message && typeof record.message === 'object' ? record.message : record;
  }

  function promptsFromMessages(records) {
    const prompts = [];
    const seen = new Set();

    for (const record of records ?? []) {
      const message = messageFromRecord(record);
      const id = typeof message?.id === 'string' ? message.id : null;
      if (!id || seen.has(id) || message?.author?.role !== 'user') continue;
      seen.add(id);

      const metadata = message.metadata ?? {};
      if (metadata.is_visually_hidden_from_conversation || metadata.is_user_system_message) {
        continue;
      }

      const text = collectPromptText(message);
      if (!text) continue; // Attachment-only turns do not become noisy labels.

      prompts.push(Object.freeze({
        id,
        text,
        createTime: Number.isFinite(message.create_time) ? message.create_time : null,
      }));
    }

    return prompts;
  }

  function legacyActiveBranch(payload) {
    const mapping = payload?.mapping;
    if (!mapping || typeof mapping !== 'object') return [];

    const branch = [];
    const visited = new Set();
    let nodeId = payload.current_node;

    while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
      visited.add(nodeId);
      const node = mapping[nodeId];
      if (node.message) branch.push(node.message);
      nodeId = node.parent;
    }

    return branch.reverse();
  }

  class ConversationSource {
    constructor(request) {
      this.request = request;
    }

    headers(context, ownerId = null) {
      const headers = {};
      if (context.projectId) headers['chatgpt-project-id'] = context.projectId;
      if (ownerId ?? context.ownerId) {
        headers['chatgpt-conv-owner-id'] = ownerId ?? context.ownerId;
      }
      return headers;
    }

    unwrap(payload) {
      const page = Array.isArray(payload?.messages) ? payload : payload?.conversation;
      if (!Array.isArray(page?.messages)) {
        throw new ConversationDataError('Unsupported conversation message data');
      }
      const info = page.page_info ?? payload.page_info;
      if (typeof info?.has_previous_page !== 'boolean'
        || (info.has_previous_page && (typeof info.start_cursor !== 'string' || !info.start_cursor))) {
        throw new ConversationDataError('Unsupported conversation pagination data');
      }
      for (const record of page.messages) {
        const message = messageFromRecord(record);
        if (typeof message?.id !== 'string' || !message.id
          || typeof message?.author?.role !== 'string') {
          throw new ConversationDataError('Unsupported conversation message record');
        }
      }
      return { messages: page.messages, page_info: info };
    }

    ownerId(payload) {
      const owner = payload?.owner ?? payload?.conversation_owner;
      if (typeof owner === 'string') return owner;
      return owner?.id ?? payload?.owner_id ?? payload?.conversation_owner_id ?? null;
    }

    async load(context, signal, onProgress, checkpoint = null) {
      const state = checkpoint ?? {
        key: context.key,
        mode: 'paged',
        ownerId: null,
        cursor: null,
        usedCursors: new Set(),
        seenMessageIds: new Set(),
        items: [],
        pages: 0,
        complete: false,
      };
      if (state.key !== context.key) throw new ConversationDataError('Conversation checkpoint mismatch');
      try {
        if (state.mode === 'legacy') return await this.loadLegacy(context, signal);
        try {
          return await this.loadPaged(context, signal, onProgress, state);
        } catch (error) {
          // An unsupported first endpoint may use the verified legacy graph.
          // A failed history page must not silently restart as another source.
          if (state.pages || !(error instanceof HttpError) || ![400, 404, 405].includes(error.status)) {
            throw error;
          }
          state.mode = 'legacy';
          return await this.loadLegacy(context, signal);
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new ConversationLoadError(error, state);
      }
    }

    snapshot(state) {
      return {
        items: state.items.slice(),
        status: state.complete ? 'complete' : 'partial',
        checkpoint: state.complete ? null : state,
      };
    }

    async loadPaged(context, signal, onProgress, state) {
      const base = `/backend-api/conversations/${encodeURIComponent(context.conversationId)}`;
      while (!state.complete) {
        throwIfAborted(signal);
        const before = state.cursor;
        if (before && state.usedCursors.has(before)) {
          throw new ConversationDataError('Conversation pagination repeated a cursor');
        }
        const query = new URLSearchParams({
          include_has_versions: 'true',
          num_turns: String(CONFIG.apiPageSizeTurns),
        });
        if (before) query.set('before', before);
        const raw = await this.request.json(`${base}${before ? '/messages' : ''}?${query}`, {
          headers: this.headers(context, state.ownerId),
          signal,
        });
        throwIfAborted(signal);
        const page = this.unwrap(raw);
        const nextCursor = page.page_info.has_previous_page ? page.page_info.start_cursor : null;
        if (nextCursor && (nextCursor === before || state.usedCursors.has(nextCursor))) {
          throw new ConversationDataError('Conversation pagination did not advance');
        }
        const newRecords = [];
        const pageIds = new Set();
        for (const record of page.messages) {
          const id = messageFromRecord(record).id;
          if (!state.seenMessageIds.has(id) && !pageIds.has(id)) newRecords.push(record);
          pageIds.add(id);
        }
        if (state.pages && nextCursor && !newRecords.length) {
          throw new ConversationDataError('Conversation pagination returned no new messages');
        }

        // Commit only a fully validated page. A failed read resumes at this
        // cursor; successful pages, including tool-only pages, are retained.
        if (before) state.usedCursors.add(before);
        pageIds.forEach((id) => state.seenMessageIds.add(id));
        const olderPrompts = promptsFromMessages(newRecords);
        state.items = olderPrompts.concat(state.items);
        state.ownerId ||= this.ownerId(raw) ?? this.ownerId(raw.conversation);
        state.cursor = nextCursor;
        state.pages += 1;
        state.complete = !nextCursor;
        if (olderPrompts.length || state.pages === 1 || state.complete) onProgress?.(this.snapshot(state));

        // Yield, do not truncate, a large but progressing history. There is no
        // total page ceiling and no scrolling to manufacture DOM content.
        if (!state.complete && state.pages % CONFIG.apiYieldEveryPages === 0) {
          await cancellableDelay(0, signal);
        }
      }
      return this.snapshot(state);
    }

    async loadLegacy(context, signal) {
      const path = `/backend-api/conversation/${encodeURIComponent(context.conversationId)}`;
      const payload = await this.request.json(path, {
        headers: this.headers(context),
        signal,
      });
      throwIfAborted(signal);
      let messages;
      if (Array.isArray(payload?.messages)) {
        // Only an explicit complete page is accepted as a non-graph legacy
        // result; a paginated list is not silently labeled complete.
        const page = this.unwrap(payload);
        if (page.page_info.has_previous_page) {
          throw new ConversationDataError('Legacy conversation response is incomplete');
        }
        messages = page.messages;
      } else {
        const mapping = payload?.mapping;
        if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
          throw new ConversationDataError('Unsupported legacy conversation data');
        }
        const visited = new Set();
        let nodeId = payload.current_node;
        if (!nodeId && Object.keys(mapping).length) {
          throw new ConversationDataError('Legacy conversation has no active branch');
        }
        while (nodeId) {
          const node = mapping[nodeId];
          if (typeof nodeId !== 'string' || visited.has(nodeId) || !node
            || (node.parent !== null && typeof node.parent !== 'string')) {
            throw new ConversationDataError('Legacy conversation ancestry is incomplete');
          }
          visited.add(nodeId);
          nodeId = node.parent;
        }
        messages = legacyActiveBranch(payload);
        for (const record of messages) {
          if (typeof record.id !== 'string' || typeof record.author?.role !== 'string') {
            throw new ConversationDataError('Unsupported legacy message record');
          }
        }
      }
      return { items: promptsFromMessages(messages), status: 'complete', checkpoint: null };
    }
  }

  const DomTurns = {
    all() {
      // ChatGPT retains hidden copies of recently visited routes. Their turn
      // keys and text still exist, but their geometry is zero and must never
      // enter the current conversation's location or navigation model.
      return Array.from(document.querySelectorAll(SELECTOR.turn))
        .filter((turn) => turn.getClientRects().length > 0);
    },

    find(messageId) {
      return this.all().find((turn) => turn.getAttribute('data-turn-key') === messageId) ?? null;
    },

    promptText(userUnit) {
      const exactTargets = Array.from(userUnit.querySelectorAll(SELECTOR.promptText));
      const exact = normalizeText(exactTargets.map((node) => node.innerText).join(' '));
      if (exact) return exact;

      // Conservative fallback for a transient markup variation. Controls are
      // removed from a detached clone, so the live conversation is untouched.
      const bubble = userUnit.querySelector(SELECTOR.userBubble);
      if (!bubble) return '';
      const clone = bubble.cloneNode(true);
      clone.querySelectorAll('button,[role="button"],[aria-hidden="true"],svg').forEach((node) => node.remove());
      return normalizeText(clone.innerText || clone.textContent);
    },

    prompts() {
      const result = [];
      const seen = new Set();

      for (const turn of this.all()) {
        const userUnit = turn.querySelector(USER_UNIT_SELECTOR);
        if (!userUnit) continue;

        const idAttribute = userUnit.getAttribute('data-chatgpt-search-message-ids');
        const id = turn.getAttribute('data-turn-key') ?? idAttribute?.split(/\s+/)[0];
        if (!id || seen.has(id)) continue;

        const text = this.promptText(userUnit);
        if (!text) continue;
        seen.add(id);
        result.push(Object.freeze({ id, text, createTime: null }));
      }
      return result;
    },

    signature() {
      return this.all().map((turn) => turn.getAttribute('data-turn-key') ?? '').join('|');
    },

    scroller(turn = null) {
      const preferred = turn?.closest(SELECTOR.threadScroller)
        ?? Array.from(document.querySelectorAll(SELECTOR.threadScroller))
          .find((node) => node.clientHeight > 0);
      if (preferred?.clientHeight > 0) return preferred;

      let node = turn?.parentElement ?? null;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
          return node;
        }
        node = node.parentElement;
      }
      return document.scrollingElement;
    },

    scrollTo(messageId) {
      const turn = this.find(messageId);
      if (!turn) return false;

      const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const behavior = reducedMotion ? 'auto' : 'smooth';
      const scroller = this.scroller(turn);
      const target = turn.querySelector(USER_UNIT_SELECTOR) ?? turn;
      const rect = target.getBoundingClientRect();

      if (scroller && scroller !== document.scrollingElement) {
        const rootRect = scroller.getBoundingClientRect();
        const top = scroller.scrollTop + rect.top - rootRect.top - CONFIG.navigationTopOffsetPx;
        scroller.scrollTo({ top, behavior });
      } else {
        const top = window.scrollY + rect.top - CONFIG.navigationTopOffsetPx;
        window.scrollTo({ top, behavior });
      }
      return true;
    },
  };

  function mergeRenderedPrompts(sourceItems, renderedItems) {
    if (!sourceItems.length) return renderedItems.slice();

    const result = sourceItems.map((item) => ({ ...item }));
    const index = new Map(result.map((item, position) => [item.id, position]));

    // A rendered bubble may be collapsed or clipped by the host. Known IDs
    // keep authoritative source text; new DOM turns appear immediately and
    // genuine edits are reconciled by refreshing the conversation source.

    for (let renderedIndex = 0; renderedIndex < renderedItems.length; renderedIndex += 1) {
      const rendered = renderedItems[renderedIndex];
      if (index.has(rendered.id)) continue;

      let insertion = result.length;
      for (let next = renderedIndex + 1; next < renderedItems.length; next += 1) {
        const nextPosition = result.findIndex((item) => item.id === renderedItems[next].id);
        if (nextPosition >= 0) {
          insertion = nextPosition;
          break;
        }
      }
      result.splice(insertion, 0, rendered);
      index.clear();
      result.forEach((item, position) => index.set(item.id, position));
    }

    return result;
  }

  function promptIndexForRailSlot(slot, lineCount, promptCount) {
    if (promptCount <= 1 || lineCount <= 1) return 0;
    return Math.max(0, Math.min(
      promptCount - 1,
      Math.round(slot * (promptCount - 1) / (lineCount - 1)),
    ));
  }

  // Literal prefixes and typo tolerance have separate policies. Short typed
  // prefixes are useful immediately; approximate spelling needs more evidence.
  const SEARCH = Object.freeze({
    inputMaxLength: 160,
    debounceMs: 35,
    sliceBudgetMs: 8,
    fuzzyMinLength: 5,
    twoEditMinLength: 8,
    fuzzyMaxLength: 64,
    minQueryLength: 2,
    previewSourceLimit: 512,
    previewMeasureCacheLimit: 2048,
    previewResizeDelayMs: 80,
    revealMs: 120,
    retractDelayMs: 80,
    toggleHitWidthPx: 48,
    shelfHeightPx: 42,
  });

  function foldSearchWord(value) {
    return value.normalize('NFKD').toLowerCase()
      .replace(/\p{M}/gu, '').replace(/ß/g, 'ss').replace(/ς/g, 'σ');
  }

  function* buildSearchDocument(text) {
    const tokens = [];
    let compact = '';
    // Keep +/# attached to names such as C++ and C#. Punctuation and spacing
    // otherwise separate words; original UTF-16 offsets are used for display.
    for (const match of text.matchAll(/[\p{L}\p{N}\p{M}]+[+#]*/gu)) {
      const key = foldSearchWord(match[0]);
      if (!key) continue;
      tokens.push({ key, start: match.index, end: match.index + match[0].length,
        offset: compact.length });
      compact += key;
      if (tokens.length % 256 === 0) yield;
    }
    return { text, tokens, compact };
  }

  function searchDocument(text) {
    const work = buildSearchDocument(text);
    let step = work.next();
    while (!step.done) step = work.next();
    return step.value;
  }

  function isSearchQuery(query) {
    return Array.from(query.compact).length >= SEARCH.minQueryLength;
  }

  // Banded optimal-string-alignment distance (Damerau–Levenshtein variant):
  // insertion, deletion, substitution and adjacent transposition. The narrow
  // band bounds fuzzy work; it is never used to reject an exact long word.
  function boundedEditDistance(left, right, limit) {
    const a = Array.from(left);
    const b = Array.from(right);
    if (Math.abs(a.length - b.length) > limit) return limit + 1;
    let older = null;
    let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i += 1) {
      const row = new Array(b.length + 1).fill(limit + 1);
      row[0] = i;
      let minimum = row[0];
      for (let j = Math.max(1, i - limit); j <= Math.min(b.length, i + limit); j += 1) {
        row[j] = Math.min(row[j - 1] + 1, previous[j] + 1,
          previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
        if (older && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          row[j] = Math.min(row[j], older[j - 2] + 1);
        }
        minimum = Math.min(minimum, row[j]);
      }
      if (minimum > limit) return limit + 1;
      older = previous;
      previous = row;
    }
    return Math.min(previous[b.length], limit + 1);
  }

  function wordMatchScore(query, word) {
    if (query === word) return 0;
    if (word.startsWith(query)) return 0.25;
    if (!/^\p{L}+$/u.test(query) || !/^\p{L}+$/u.test(word)) return Infinity;
    const length = Array.from(query).length;
    if (length < SEARCH.fuzzyMinLength || length > SEARCH.fuzzyMaxLength
      || word.length > SEARCH.fuzzyMaxLength * 2) return Infinity;
    const limit = length >= SEARCH.twoEditMinLength ? 2 : 1;
    if (Math.abs(Array.from(word).length - length) > limit) return Infinity;
    const distance = boundedEditDistance(query, word, limit);
    return distance <= limit ? 1 + distance / length : Infinity;
  }

  function mergeMatchRanges(ranges) {
    const result = [];
    for (const range of ranges.slice().sort((a, b) => a.start - b.start)) {
      const last = result.at(-1);
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else result.push({ start: range.start, end: range.end });
    }
    return result;
  }

  function compactTokenIndex(doc, position) {
    let low = 0;
    let high = doc.tokens.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (doc.tokens[mid].offset <= position) low = mid + 1;
      else high = mid - 1;
    }
    return high;
  }

  function sourceKeyRange(text, token, from, to) {
    const raw = text.slice(token.start, token.end);
    if (raw.length === token.key.length && (raw === token.key || raw.toLowerCase() === token.key)) {
      return { start: token.start + from, end: token.start + to };
    }
    // Map only the matched part, retaining complete original characters and
    // combining marks when normalization expands a ligature or removes accents.
    let cursor = token.start;
    let folded = 0;
    let start = null;
    let end = cursor;
    for (const character of raw) {
      const width = foldSearchWord(character).length;
      if (width && folded >= to) break;
      if (width && folded + width > from && start === null) start = cursor;
      if (folded < to || (!width && start !== null)) end = cursor + character.length;
      folded += width;
      cursor += character.length;
    }
    return { start: start ?? token.start, end };
  }

  function compactMatchRange(doc, offset, end) {
    const first = doc.tokens[compactTokenIndex(doc, offset)];
    const last = doc.tokens[compactTokenIndex(doc, end - 1)];
    if (first === last) return sourceKeyRange(doc.text, first,
      offset - first.offset, end - first.offset);
    return {
      start: sourceKeyRange(doc.text, first, offset - first.offset, first.key.length).start,
      end: sourceKeyRange(doc.text, last, 0, end - last.offset).end,
    };
  }

  function* literalSearchRange(doc, query) {
    // Start at a word boundary, but allow the typed query to end anywhere.
    // Compact text crosses punctuation/spacing, so 32d stays a prefix of 32” DDD.
    // Scripts without word spacing also support an internal literal substring.
    const internal = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(query.compact);
    let offset = doc.compact.indexOf(query.compact);
    let checked = 0;
    while (offset >= 0) {
      const first = compactTokenIndex(doc, offset);
      if (internal || doc.tokens[first].offset === offset) {
        return [compactMatchRange(doc, offset, offset + query.compact.length)];
      }
      const next = doc.tokens[first + 1]?.offset;
      if (next === undefined) break;
      offset = doc.compact.indexOf(query.compact, next);
      if (++checked % 256 === 0) yield;
    }
    return null;
  }

  function* matchSearchDocument(doc, query, comparisons) {
    const literal = yield* literalSearchRange(doc, query);
    if (literal) return literal;
    const ranges = [];
    let checked = 0;
    for (let q = 0; q < query.tokens.length; q += 1) {
      const key = query.tokens[q].key;
      let best = null;
      let bestScore = Infinity;
      const scores = comparisons[q];
      for (let t = 0; t < doc.tokens.length; t += 1) {
        const token = doc.tokens[t];
        // A joined pair handles a typo together with a missing space.
        const candidates = [{ key: token.key, end: token.end }];
        if (key.length >= SEARCH.fuzzyMinLength && doc.tokens[t + 1]) {
          candidates.push({ key: token.key + doc.tokens[t + 1].key, end: doc.tokens[t + 1].end });
        }
        for (const candidate of candidates) {
          let score = scores.get(candidate.key);
          if (score === undefined) {
            score = wordMatchScore(key, candidate.key);
            scores.set(candidate.key, score);
          }
          if (score < bestScore) {
            bestScore = score;
            best = candidate.key.startsWith(key)
              ? compactMatchRange(doc, token.offset, token.offset + key.length)
              : { start: token.start, end: candidate.end };
          }
        }
        if (bestScore === 0) break;
        if (++checked % 256 === 0) yield;
      }
      if (!best) return null;
      ranges.push(best);
    }
    return ranges;
  }

  class PromptSearch {
    constructor() {
      this.items = [];
      this.documents = new Map();
    }

    setItems(items) {
      this.items = items.slice();
      const current = new Map(items.map((item) => [item.id, item.text]));
      for (const [id, doc] of this.documents) {
        if (current.get(id) !== doc.text) this.documents.delete(id);
      }
    }

    clear() {
      this.items = [];
      this.documents.clear();
    }

    async find(value, signal) {
      const query = searchDocument(value);
      if (!isSearchQuery(query)) {
        return this.items.map((item) => ({ item, ranges: [] }));
      }
      const items = this.items;
      const results = [];
      // Query-local comparisons are shared across repeated vocabulary, then
      // released. The only persistent cache belongs to this conversation.
      const comparisons = query.tokens.map(() => new Map());
      let sliceStarted = performance.now();
      // Generators checkpoint both indexing and matching inside a single
      // unusually long prompt, as well as between ordinary prompts.
      const complete = async (work) => {
        let step = work.next();
        while (!step.done) {
          throwIfAborted(signal);
          if (performance.now() - sliceStarted >= SEARCH.sliceBudgetMs) {
            await cancellableDelay(0, signal);
            sliceStarted = performance.now();
          }
          step = work.next();
        }
        return step.value;
      };
      for (const item of items) {
        throwIfAborted(signal);
        let doc = this.documents.get(item.id);
        if (!doc) {
          doc = await complete(buildSearchDocument(item.text));
          throwIfAborted(signal);
          this.documents.set(item.id, doc);
        }
        const ranges = await complete(matchSearchDocument(doc, query, comparisons));
        if (ranges) results.push({ item, ranges: mergeMatchRanges(ranges) });
        if (performance.now() - sliceStarted >= SEARCH.sliceBudgetMs) {
          await cancellableDelay(0, signal);
          sliceStarted = performance.now();
        }
      }
      throwIfAborted(signal);
      return results;
    }
  }

  const PREVIEW_WORDS = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
  const PREVIEW_GRAPHEMES = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const PREVIEW_SENTENCES = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'sentence' }) : null;

  function cachedPreviewMeasure(measure) {
    // One cache per render/font measurement context. It is discarded after
    // that operation, so fonts, size and spacing never inherit old widths.
    const widths = new Map();
    return (value, highlighted = false) => {
      const key = `${Number(highlighted)}\u0000${value}`;
      if (widths.has(key)) return widths.get(key);
      const width = measure(value, highlighted);
      if (widths.size < SEARCH.previewMeasureCacheLimit) widths.set(key, width);
      return width;
    };
  }

  function searchPreview(text, ranges, metrics) {
    if (!ranges.length) return { start: 0, end: text.length };
    const width = Math.max(24, metrics.width - metrics.measure('… '));
    const measured = (start, end) => {
      let cursor = start;
      let total = 0;
      for (const range of ranges) {
        const a = Math.max(start, range.start);
        const b = Math.min(end, range.end);
        if (b <= a) continue;
        total += metrics.measure(text.slice(cursor, a), false);
        total += metrics.measure(text.slice(a, b), true);
        cursor = b;
      }
      return total + metrics.measure(text.slice(cursor, end), false);
    };
    // Reserve room for an omission marker. Whole words wrap naturally; an
    // oversized unbroken word may wrap anywhere, as in the preview's CSS.
    const fits = (start, end) => {
      if (end - start > SEARCH.previewSourceLimit) return false;
      let line = 1;
      let used = 0;
      let gap = 0;
      for (const unit of text.slice(start, end).matchAll(/\s+|\S+/gu)) {
        const a = start + unit.index;
        const advance = measured(a, a + unit[0].length);
        if (/^\s/u.test(unit[0])) { gap = advance; continue; }
        if (used + gap + advance <= width) used += gap + advance;
        else if (advance <= width) { line += 1; used = advance; }
        else {
          if (used) line += 1;
          const lines = Math.ceil(advance / width);
          line += lines - 1;
          used = advance - (lines - 1) * width;
        }
        gap = 0;
        if (line > 2) return false;
      }
      return true;
    };

    // Prefer a cluster that shows more of a multi-term query. Ties retain the
    // earlier context. There is one continuous source window, never a stitched
    // opening plus a duplicate excerpt or a forced per-line template.
    let anchor = { start: ranges[0].start, end: ranges[0].end, count: 1 };
    for (let i = 0; i < ranges.length; i += 1) {
      for (let j = i + 1; j < ranges.length; j += 1) {
        if (!fits(ranges[i].start, ranges[j].end)) break;
        if (j - i + 1 > anchor.count) {
          anchor = { start: ranges[i].start, end: ranges[j].end, count: j - i + 1 };
        }
      }
    }

    let start = 0;
    if (!fits(0, anchor.end)) {
      start = anchor.start;
      const lookbehind = Math.max(0, anchor.start - SEARCH.previewSourceLimit);
      const before = text.slice(lookbehind, anchor.start);
      const starts = PREVIEW_WORDS
        ? Array.from(PREVIEW_WORDS.segment(before))
          .filter((part) => part.isWordLike).map((part) => part.index)
        : Array.from(before.matchAll(/\S+/gu), (part) => part.index);
      const hitWidth = anchor.end - anchor.start > SEARCH.previewSourceLimit
        ? width : measured(anchor.start, anchor.end);
      const contextBudget = Math.min(width * .45, Math.max(0, width - Math.min(hitWidth, width)));
      for (let i = starts.length - 1; i >= 0; i -= 1) {
        const candidate = lookbehind + starts[i];
        // A bounded lookbehind can start inside a word: do not publish that
        // artificial boundary as a readable excerpt start.
        if (!starts[i] && lookbehind && /\S/u.test(text[lookbehind - 1])) continue;
        if (measured(candidate, anchor.start) > contextBudget || !fits(candidate, anchor.end)) break;
        start = candidate;
      }
      if (PREVIEW_SENTENCES && start < anchor.start) {
        const context = text.slice(start, Math.min(text.length, anchor.end + 64));
        const origin = start;
        for (const sentence of PREVIEW_SENTENCES.segment(context)) {
          if (origin + sentence.index > anchor.start) break;
          // Avoid opening with the dangling tail of an unrelated sentence.
          start = origin + sentence.index;
        }
      }
    }

    let end = Math.min(text.length, start + SEARCH.previewSourceLimit);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      if (space > Math.max(start, anchor.end)) end = space;
      else if (PREVIEW_GRAPHEMES) {
        const part = PREVIEW_GRAPHEMES.segment(text).containing(end);
        end = part.index > start ? part.index : part.index + part.segment.length;
      } else {
        // Without grapheme segmentation, retain a whole unspaced word. CSS
        // still bounds the visible result to two lines.
        const nextSpace = text.indexOf(' ', end);
        end = nextSpace < 0 ? text.length : nextSpace;
      }
    }
    return { start, end };
  }

  class TocView {
    constructor(onNavigate, onOpen = () => {}) {
      document.getElementById(`${NS}-root`)?.remove();

      this.onNavigate = onNavigate;
      this.onOpen = onOpen;
      this.items = [];
      this.activeId = null;
      this.railSlot = -1;
      this.hoverId = null;
      this.open = false;
      this.closeTimer = 0;
      this.pointerInside = false;
      this.search = new PromptSearch();
      this.entries = [];
      this.query = '';
      this.searchVisible = false;
      this.hoverFocus = null;
      this.searchSessionStarted = false;
      this.pointerInSearch = false;
      this.searchRetractTimer = 0;
      this.searchPending = false;
      this.searchController = null;
      this.searchSequence = 0;
      this.loadStatus = 'idle';
      this.destroyed = false;
      this.searchSoon = createDebouncer(() => this.runSearch(), SEARCH.debounceMs);
      this.previewRefreshSoon = createDebouncer(() => this.refreshPreviews(), SEARCH.previewResizeDelayMs);
      this.onFontsReady = () => {
        if (this.hasSearchQuery()) this.previewRefreshSoon();
      };

      this.host = document.createElement('div');
      this.host.id = `${NS}-root`;
      this.host.hidden = true;
      document.body.append(this.host);

      this.shadow = this.host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = this.styles();
      this.shadow.append(style);

      this.dock = document.createElement('div');
      this.dock.className = `${NS}__dock`;

      this.rail = document.createElement('div');
      this.rail.className = `${NS}__rail`;
      this.railList = document.createElement('ol');
      this.railList.className = `${NS}__rail-list`;
      this.rail.append(this.railList);

      this.panel = document.createElement('nav');
      this.panel.className = `${NS}__panel`;
      this.panel.setAttribute('aria-label', 'Conversation contents');
      this.panelList = document.createElement('ol');
      this.panelList.className = `${NS}__panel-list`;
      this.panel.append(this.panelList);

      this.createSearchShelf();
      this.dock.append(this.panel, this.rail, this.searchShelf);
      this.announcer = document.createElement('span');
      this.announcer.className = `${NS}__sr-only`;
      this.announcer.setAttribute('role', 'status');
      this.announcer.setAttribute('aria-live', 'polite');
      this.dock.append(this.announcer);
      this.previewProbe = document.createElement('button');
      this.previewProbe.type = 'button';
      this.previewProbe.className = `${NS}__panel-item`;
      this.previewProbe.hidden = true;
      this.previewProbe.tabIndex = -1;
      this.previewProbe.setAttribute('aria-hidden', 'true');
      const probeText = document.createElement('span');
      probeText.className = `${NS}__preview`;
      const probeMark = document.createElement('mark');
      probeMark.textContent = 'M';
      probeText.append(probeMark);
      this.previewProbe.append(probeText);
      this.dock.append(this.previewProbe);
      this.shadow.append(this.dock);
      this.bindEvents();
      document.fonts?.addEventListener('loadingdone', this.onFontsReady);
    }

    searchIcon(clear = false) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', clear ? 'm7 7 10 10M17 7 7 17'
        : 'M20 20l-4.3-4.3M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z');
      svg.append(path);
      return svg;
    }

    createSearchShelf() {
      this.searchShelf = document.createElement('div');
      this.searchShelf.className = `${NS}__search-shelf`;
      this.searchButton = document.createElement('button');
      this.searchButton.type = 'button';
      this.searchButton.className = `${NS}__search-toggle`;
      this.searchButton.setAttribute('aria-label', 'Search Prompts');
      this.searchButton.setAttribute('aria-expanded', 'false');
      this.searchButton.setAttribute('aria-controls', `${NS}-search-field`);
      this.searchButton.append(this.searchIcon());

      this.searchField = document.createElement('div');
      this.searchField.id = `${NS}-search-field`;
      this.searchField.className = `${NS}__search-field`;
      this.searchField.setAttribute('role', 'search');
      this.searchField.inert = true;
      this.searchField.setAttribute('aria-hidden', 'true');
      this.searchInput = document.createElement('input');
      this.searchInput.type = 'search';
      this.searchInput.maxLength = SEARCH.inputMaxLength;
      this.searchInput.placeholder = 'Search Prompts…';
      this.searchInput.setAttribute('aria-label', 'Search conversation prompts');
      this.searchInput.setAttribute('autocomplete', 'off');
      this.searchInput.setAttribute('spellcheck', 'false');
      this.searchInput.setAttribute('aria-controls', `${NS}-prompt-list`);
      this.panelList.id = `${NS}-prompt-list`;
      this.clearButton = document.createElement('button');
      this.clearButton.type = 'button';
      this.clearButton.className = `${NS}__search-clear`;
      this.clearButton.setAttribute('aria-label', 'Clear search');
      this.clearButton.hidden = true;
      this.clearButton.append(this.searchIcon(true));
      this.searchField.append(this.searchIcon(), this.searchInput, this.clearButton);
      this.searchShelf.append(this.searchButton, this.searchField);
    }

    styles() {
      return `
        :host {
          all: initial;
          position: fixed;
          top: 50%;
          right: ${CONFIG.rightOffsetCss};
          z-index: 40;
          width: 0;
          height: 0;
          color: var(--color-text-primary, #0d0d0d);
          font-family: inherit;
          color-scheme: inherit;
          pointer-events: none;
        }

        *, *::before, *::after { box-sizing: border-box; }

        .${NS}__dock {
          --${NS}-panel-width: min(
            ${CONFIG.panelWidthPx}px,
            calc(100vw - ${CONFIG.rightOffsetCss} - 18px)
          );
          --${NS}-surface: color-mix(in srgb,
            var(--color-surface-elevated-secondary, var(--color-token-main-surface-primary, #fff)) 97%, transparent);
          --${NS}-border: color-mix(in srgb, var(--color-text-primary, #0d0d0d) 8%, transparent);
          position: absolute;
          top: 0;
          right: 0;
          width: ${CONFIG.railHitWidthPx}px;
          height: var(--${NS}-rail-height, ${CONFIG.triggerMinHeightPx}px);
          transform: translateY(-50%);
          pointer-events: auto;
        }

        .${NS}__dock--open {
          width: var(--${NS}-panel-width);
          height: var(--${NS}-panel-height, ${CONFIG.triggerMinHeightPx}px);
        }

        .${NS}__rail {
          position: absolute;
          top: 50%;
          right: 0;
          width: ${CONFIG.railHitWidthPx}px;
          height: var(--${NS}-rail-height, ${CONFIG.triggerMinHeightPx}px);
          transform: translateY(-50%);
          transition: opacity ${CONFIG.transitionMs}ms ease;
        }

        .${NS}__dock--open .${NS}__rail {
          opacity: 0;
          pointer-events: none;
        }

        .${NS}__rail-list,
        .${NS}__panel-list {
          margin: 0;
          padding: 0;
          list-style: none;
        }

        .${NS}__rail-list {
          display: flex;
          height: 100%;
          padding: ${CONFIG.railPaddingPx}px 0;
          flex-direction: column;
          justify-content: center;
        }

        .${NS}__rail-row {
          position: relative;
          height: ${CONFIG.railRowHeightPx}px;
          flex: 0 0 ${CONFIG.railRowHeightPx}px;
        }

        .${NS}__rail-item {
          display: block;
          width: 100%;
          height: 100%;
          padding: 0;
          border: 0;
          background: none;
          cursor: pointer;
        }

        .${NS}__line {
          position: absolute;
          top: 50%;
          right: 0;
          width: ${CONFIG.railLineWidthPx}px;
          height: ${CONFIG.railLineHeightPx}px;
          border-radius: 999px;
          background: var(--color-text-tertiary, #8f8f8f);
          opacity: .57;
          transform: translateY(-50%);
        }

        .${NS}__rail-row--active .${NS}__line {
          background: var(--color-text-primary, #0d0d0d);
          opacity: 1;
        }

        .${NS}__rail-row--hovered .${NS}__line,
        .${NS}__rail-item:focus-visible .${NS}__line {
          background: var(--color-text-primary, #0d0d0d);
          opacity: 1;
        }

        .${NS}__rail-item:focus-visible,
        .${NS}__panel-item:focus-visible { outline: none; }

        .${NS}__rail-item:focus-visible .${NS}__line {
          box-shadow: 0 0 0 2px var(--color-token-main-surface-primary, #fff);
        }

        .${NS}__panel {
          position: absolute;
          top: 50%;
          right: 0;
          width: var(--${NS}-panel-width);
          height: var(--${NS}-panel-height, ${CONFIG.triggerMinHeightPx}px);
          overflow-x: hidden;
          overflow-y: auto;
          overscroll-behavior: contain;
          scrollbar-width: thin;
          scrollbar-color: color-mix(in srgb, var(--color-text-primary, #0d0d0d) 23%, transparent) transparent;
          border: 1px solid var(--${NS}-border);
          border-radius: 12px;
          background: var(--${NS}-surface);
          box-shadow: 0 9px 28px rgb(0 0 0 / 13%);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          transform: translateY(-50%) translateX(6px);
          transform-origin: right center;
          transition:
            opacity 110ms ease,
            transform ${CONFIG.transitionMs}ms cubic-bezier(.2, .78, .24, 1),
            visibility 0s linear ${CONFIG.transitionMs}ms;
        }

        .${NS}__dock--open .${NS}__panel {
          opacity: 1;
          visibility: visible;
          pointer-events: auto;
          transform: translateY(-50%) translateX(0);
          transition-delay: 0s;
        }

        .${NS}__panel-list {
          padding: ${CONFIG.panelPaddingPx}px;
          display: flex;
          flex-direction: column;
        }

        .${NS}__panel-row {
          position: relative;
          height: ${CONFIG.panelRowHeightPx}px;
          flex: 0 0 ${CONFIG.panelRowHeightPx}px;
        }

        .${NS}__panel-item {
          display: flex;
          width: 100%;
          height: 100%;
          margin: 0;
          padding: 5px 8px;
          align-items: center;
          border: 0;
          border-radius: 7px;
          background: transparent;
          color: var(--color-text-secondary, #5d5d5d);
          font: inherit;
          text-align: left;
          cursor: pointer;
          opacity: .82;
          transition:
            background-color 110ms ease,
            color 110ms ease,
            opacity 110ms ease;
        }

        .${NS}__preview {
          display: -webkit-box;
          min-width: 0;
          max-height: 36px;
          overflow: hidden;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
          font-size: ${CONFIG.promptFontSizePx}px;
          font-weight: 440;
          line-height: 18px;
          letter-spacing: -.006em;
          overflow-wrap: anywhere;
        }

        .${NS}__panel-row--active .${NS}__panel-item {
          color: var(--color-text-primary, #0d0d0d);
          opacity: 1;
        }

        .${NS}__panel-row--hovered .${NS}__panel-item,
        .${NS}__panel-item:focus-visible {
          background: color-mix(
            in srgb, var(--color-text-primary, #0d0d0d) 6%, transparent
          );
          color: var(--color-text-primary, #0d0d0d);
          opacity: 1;
        }

        .${NS}__panel-item:focus-visible {
          box-shadow: inset 0 0 0 1px color-mix(
            in srgb, var(--color-text-primary, #0d0d0d) 16%, transparent
          );
        }

        [hidden] { display: none !important; }

        .${NS}__search-shelf {
          --${NS}-toggle-top: 7px;
          --${NS}-toggle-right: 4px;
          position: absolute;
          top: 100%;
          right: 0;
          width: 100%;
          height: ${SEARCH.shelfHeightPx}px;
          padding-top: 6px;
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          transition: opacity 110ms ease, visibility 0s linear ${CONFIG.transitionMs}ms;
        }

        .${NS}__dock--open .${NS}__search-shelf {
          opacity: 1;
          visibility: visible;
          transition-delay: 0s;
        }
        .${NS}__dock--open .${NS}__search-shelf--expanded { pointer-events: auto; }

        .${NS}__search-toggle, .${NS}__search-clear {
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 32px;
          width: 32px;
          height: 32px;
          padding: 7px;
          margin-left: auto;
          border: 0;
          border-radius: 8px;
          background: transparent;
          color: var(--color-text-tertiary, #8f8f8f);
          cursor: pointer;
        }

        .${NS}__search-toggle {
          position: absolute;
          top: var(--${NS}-toggle-top);
          right: var(--${NS}-toggle-right);
          margin: 0;
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          transition: opacity 70ms ease, visibility 0s linear 70ms;
        }
        /* Enlarge the existing button's hit area without moving or enlarging
           its visible icon. The target stays within the search shelf. */
        .${NS}__search-toggle::before {
          content: '';
          position: absolute;
          top: calc(0px - var(--${NS}-toggle-top));
          right: calc(0px - var(--${NS}-toggle-right));
          width: min(${SEARCH.toggleHitWidthPx}px, var(--${NS}-panel-width));
          height: ${SEARCH.shelfHeightPx}px;
        }
        .${NS}__dock--open .${NS}__search-toggle {
          opacity: .8;
          visibility: visible;
          pointer-events: auto;
          transition-delay: 0s;
        }
        .${NS}__dock--open .${NS}__search-shelf--expanded .${NS}__search-toggle {
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          transition-delay: 0s, 70ms;
        }
        .${NS}__search-shelf svg {
          width: 16px;
          height: 16px;
          flex: 0 0 16px;
          fill: none;
          stroke: currentColor;
          stroke-width: 1.65;
          stroke-linecap: round;
          stroke-linejoin: round;
          pointer-events: none;
        }

        .${NS}__search-toggle:hover, .${NS}__search-clear:hover {
          color: var(--color-text-primary, #0d0d0d);
          background: color-mix(in srgb, currentColor 6%, transparent);
        }

        .${NS}__search-field {
          position: absolute;
          top: 6px;
          right: 0;
          display: flex;
          align-items: center;
          gap: 8px;
          width: 40px;
          height: 34px;
          padding: 0 4px 0 11px;
          overflow: hidden;
          border: 1px solid var(--${NS}-border);
          border-radius: 10px;
          background: var(--${NS}-surface);
          color: var(--color-text-tertiary, #8f8f8f);
          box-shadow: 0 4px 14px rgb(0 0 0 / 7%);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          transition:
            width ${SEARCH.revealMs}ms cubic-bezier(.2, .8, .2, 1),
            opacity ${SEARCH.revealMs}ms ease,
            visibility 0s linear ${SEARCH.revealMs}ms;
        }
        .${NS}__dock--open .${NS}__search-shelf--expanded .${NS}__search-field {
          width: 100%;
          opacity: 1;
          visibility: visible;
          pointer-events: auto;
          transition-delay: 0s;
        }

        .${NS}__search-field input {
          flex: 1 1 auto;
          min-width: 0;
          width: 100%;
          height: 100%;
          padding: 0;
          border: 0;
          outline: none;
          background: transparent;
          color: var(--color-text-primary, #0d0d0d);
          font: inherit;
          font-size: ${CONFIG.promptFontSizePx - 1}px;
          appearance: none;
          opacity: 1;
          transition: none;
        }

        /* Gate the empty input, rather than animating ::placeholder itself.
           Typing stops matching :placeholder-shown and reveals text at once.
           Clearing an already open field keeps opacity 1, with no new wait. */
        .${NS}__search-field input:placeholder-shown { opacity: 0; }
        .${NS}__dock--open .${NS}__search-shelf--expanded .${NS}__search-field input:placeholder-shown {
          opacity: 1;
          transition: opacity 0s linear ${SEARCH.revealMs}ms;
        }
        .${NS}__search-field input::placeholder { color: var(--color-text-secondary, #5d5d5d); }
        .${NS}__search-field input::-webkit-search-cancel-button { display: none; }
        .${NS}__search-field:focus-within {
          border-color: color-mix(in srgb, var(--color-text-primary, #0d0d0d) 18%, transparent);
        }
        .${NS}__search-toggle:focus-visible, .${NS}__search-clear:focus-visible {
          outline: 1px solid color-mix(in srgb, var(--color-text-primary, #0d0d0d) 28%, transparent);
          outline-offset: 2px;
        }

        .${NS}__panel-list[aria-busy="true"] .${NS}__panel-item { cursor: progress; }
        .${NS}__preview mark {
          color: var(--color-text-primary, #0d0d0d);
          background: color-mix(in srgb, currentColor 10%, transparent);
          border-radius: 3px;
          font-weight: 600;
        }
        .${NS}__empty {
          padding: 18px 12px;
          color: var(--color-text-secondary, #5d5d5d);
          font-size: ${CONFIG.promptFontSizePx - 1}px;
          line-height: 20px;
        }
        .${NS}__sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          overflow: hidden;
          clip-path: inset(50%);
          white-space: nowrap;
        }

        @media (prefers-reduced-motion: reduce) {
          .${NS}__rail, .${NS}__line, .${NS}__panel,
          .${NS}__panel-item, .${NS}__search-shelf,
          .${NS}__search-toggle, .${NS}__search-field,
          .${NS}__dock--open .${NS}__search-shelf--expanded .${NS}__search-field input:placeholder-shown { transition: none; }
        }
      `;
    }

    bindEvents() {
      this.dock.addEventListener('pointerenter', () => {
        this.pointerInside = true;
        window.clearTimeout(this.closeTimer);
        this.closeTimer = 0;
        this.setOpen(true);
      });

      this.panel.addEventListener('pointermove', (event) => {
        const button = event.target.closest?.(`.${NS}__panel-item`);
        this.setHover(button?.dataset.messageId ?? null);
      });
      this.panel.addEventListener('pointerleave', () => {
        this.setHover(null);
      });

      this.dock.addEventListener('pointerleave', () => {
        this.pointerInside = false;
        this.scheduleClose();
      });

      this.dock.addEventListener('focusin', (event) => {
        window.clearTimeout(this.closeTimer);
        this.closeTimer = 0;
        this.setOpen(true);
        const button = event.target.closest?.(`.${NS}__rail-item, .${NS}__panel-item`);
        if (button) {
          const slotIndex = Number(button.dataset.slotIndex);
          if (button.classList.contains(`${NS}__rail-item`)) {
            const index = promptIndexForRailSlot(
              slotIndex,
              this.railList.children.length,
              this.items.length,
            );
            this.ensurePromptVisible(index);
            this.panelList.children[index]?.firstElementChild?.focus({ preventScroll: true });
          } else this.setHover(button.dataset.messageId);
        }
      });

      this.dock.addEventListener('focusout', (event) => {
        if (!this.dock.contains(event.relatedTarget) && !this.closeTimer) {
          this.scheduleClose();
        }
      });

      this.dock.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });

      this.searchShelf.addEventListener('pointerenter', () => {
        this.pointerInSearch = true;
        this.cancelSearchRetraction();
      });
      this.searchShelf.addEventListener('pointerleave', () => {
        this.pointerInSearch = false;
        this.scheduleSearchRetraction();
      });
      this.searchButton.addEventListener('pointerenter', () => this.revealSearchForPointer());
      this.searchField.addEventListener('pointerenter', () => this.revealSearchForPointer());
      this.searchField.addEventListener('pointerdown', () => {
        if (!this.searchSessionStarted) this.hoverFocus ??= { previous: null };
      });
      this.searchField.addEventListener('focusout', (event) => {
        if (!this.searchField.contains(event.relatedTarget) && !this.pointerInSearch) {
          this.scheduleSearchRetraction();
        }
      });
      this.searchButton.addEventListener('click', (event) => {
        if (!event?.detail) this.hoverFocus = null;
        else if (!this.searchSessionStarted) this.hoverFocus ??= { previous: null };
        this.setSearchVisible(true, true);
      });
      this.searchInput.addEventListener('compositionstart', () => {
        this.composing = true;
        this.startSearchSession();
      });
      this.searchInput.addEventListener('compositionend', () => {
        this.composing = false;
        this.setQuery(this.searchInput.value);
      });
      this.searchInput.addEventListener('input', (event) => {
        this.startSearchSession();
        if (!event.isComposing && !this.composing) this.setQuery(this.searchInput.value);
      });
      this.clearButton.addEventListener('click', () => {
        this.hoverFocus = null;
        this.setQuery('');
        this.searchInput.focus({ preventScroll: true });
      });

      this.dock.addEventListener('keydown', (event) => {
        if (event.isComposing || this.composing) return;
        if (event.target === this.searchInput) {
          // Do not let the host interpret typing/Enter as composer shortcuts.
          event.stopPropagation();
          if (event.key !== 'Escape') this.hoverFocus = null;
          if (event.key === 'ArrowDown' || event.key === 'Enter') {
            event.preventDefault();
            if (!this.searchPending) {
              this.ensurePromptVisible(0);
              this.panelList.firstElementChild?.querySelector(`.${NS}__panel-item`)?.focus({ preventScroll: true });
            }
            return;
          }
        }
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (this.query) {
          this.setQuery('');
          this.searchInput.focus({ preventScroll: true });
        } else {
          this.releaseHoverFocus();
          this.shadow.activeElement?.blur();
          this.setOpen(false);
        }
      });

      this.dock.addEventListener('click', (event) => {
        const button = event.target.closest?.(`.${NS}__rail-item, .${NS}__panel-item`);
        const id = button?.dataset.messageId;
        if (!id || (this.searchPending && button.classList.contains(`${NS}__panel-item`))) return;
        this.shadow.activeElement?.blur();
        this.setActive(id);
        this.setOpen(false);
        this.onNavigate(id);
      });
    }

    scheduleClose() {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = 0;
      if (!this.open) return;
      this.closeTimer = window.setTimeout(() => {
        this.closeTimer = 0;
        if (this.pointerInside) return;
        this.releaseHoverFocus();
        if (!this.dock.contains(this.shadow.activeElement)) this.setOpen(false);
      }, CONFIG.closeDelayMs);
    }

    ensurePromptVisible(index) {
      const top = CONFIG.panelPaddingPx + index * CONFIG.panelRowHeightPx;
      const bottom = top + CONFIG.panelRowHeightPx;
      if (top < this.panel.scrollTop) this.panel.scrollTop = top;
      else if (bottom > this.panel.scrollTop + this.panel.clientHeight) {
        this.panel.scrollTop = bottom - this.panel.clientHeight;
      }
    }

    setStatus(status) {
      this.host.dataset.state = status;
      this.loadStatus = status;
      this.updateSearchNotice();
      const notice = status === 'partial' ? 'Some conversation history could not be loaded.'
        : status === 'unavailable' ? 'Conversation history could not be loaded.' : '';
      this.panel.setAttribute('aria-label', notice ? `Conversation contents. ${notice}` : 'Conversation contents');
      if (notice) this.panel.setAttribute('title', notice);
      else this.panel.removeAttribute('title');
    }

    setOpen(open) {
      if (!this.items.length) open = false;
      if (this.open === open) return;
      this.open = open;
      if (!open) {
        window.clearTimeout(this.closeTimer);
        this.closeTimer = 0;
        this.cancelSearchRetraction();
        this.previewRefreshSoon.cancel();
        this.searchSessionStarted = false;
        this.pointerInSearch = false;
      }
      this.dock.classList.toggle(`${NS}__dock--open`, open);
      for (const row of this.railList.children) row.firstElementChild.tabIndex = open ? -1 : 0;
      if (!open) {
        this.setQuery('');
        this.setSearchVisible(false);
        this.setHover(null);
      } else {
        const activeIndex = this.indexOf(this.activeId);
        if (activeIndex >= 0) {
          // Center the reading position only on entry. Wheel and pointer
          // browsing remain independent until the panel is closed again.
          this.panel.scrollTop = activeIndex * CONFIG.panelRowHeightPx
            + CONFIG.panelPaddingPx + CONFIG.panelRowHeightPx / 2
            - this.panel.clientHeight / 2;
        }
      }
      this.applyVisuals();
      if (open) this.onOpen();
    }

    render(items) {
      const signature = items.map((item) => `${item.id}\u0000${item.text}`).join('\u0001');
      if (signature === this.signature) return;
      this.signature = signature;

      const focusedId = this.shadow.activeElement?.dataset.messageId;
      const anchor = this.panelAnchor();
      this.items = items.slice();
      this.search.setItems(this.items);

      if (!this.items.length) {
        this.cancelSearch();
        this.query = '';
        this.searchInput.value = '';
        this.clearButton.hidden = true;
        this.entries = [];
        this.search.clear();
        this.setSearchVisible(false);
        this.railList.replaceChildren();
        this.panelList.replaceChildren();
        this.panel.scrollTop = 0;
        this.panelById = new Map();
        this.highlightedPanelRow = null;
        this.hoveredPanelRow = null;
        this.highlightedRailRow = null;
        this.host.hidden = true;
        this.setOpen(false);
        this.updateSearchNotice();
        return;
      }

      // Slots belong to this index revision. A slot from a partial list must
      // not constrain the same message after an older prefix is discovered.
      this.railSlot = this.slotForActive();

      this.host.hidden = false;
      this.renderEntries();
      this.restorePanelAnchor(anchor);
      if (this.hasSearchQuery()) this.queueSearch(true);
      if (this.open && focusedId && this.panelById.has(focusedId)) {
        this.ensurePromptVisible(this.entries.findIndex(({ item }) => item.id === focusedId));
        this.panelById.get(focusedId).firstElementChild.focus({ preventScroll: true });
      }
    }

    setActive(messageId) {
      if (this.activeId === messageId) return;
      this.activeId = messageId;
      this.railSlot = this.slotForActive();
      this.applyVisuals();
    }

    indexOf(messageId) {
      return messageId ? this.items.findIndex((item) => item.id === messageId) : -1;
    }

    slotForActive() {
      const index = this.indexOf(this.activeId);
      if (index < 0) return -1;
      const lines = Math.min(this.items.length, CONFIG.railLineLimit);
      return Math.round(index * (lines - 1) / Math.max(1, this.items.length - 1));
    }

    renderEntries() {
      const count = Math.min(this.items.length, CONFIG.railLineLimit);
      const railHeight = Math.max(
        CONFIG.triggerMinHeightPx,
        Math.ceil(count * CONFIG.railRowHeightPx + 2 * CONFIG.railPaddingPx),
      );
      const panelRows = this.visiblePanelRows();
      const panelHeight = Math.max(
        CONFIG.triggerMinHeightPx,
        panelRows * CONFIG.panelRowHeightPx + 2 * CONFIG.panelPaddingPx,
      );
      this.dock.style.setProperty(`--${NS}-rail-height`, `${railHeight}px`);
      this.dock.style.setProperty(`--${NS}-panel-height`, `${panelHeight}px`);

      const replaceRail = this.railList.children.length !== count;
      const railFragment = replaceRail ? document.createDocumentFragment() : null;
      for (let slotIndex = 0; slotIndex < count; slotIndex += 1) {
        let railButton;
        if (replaceRail) {
          const railRow = document.createElement('li');
          railRow.className = `${NS}__rail-row`;
          railButton = document.createElement('button');
          railButton.type = 'button';
          railButton.className = `${NS}__rail-item`;
          const line = document.createElement('span');
          line.className = `${NS}__line`;
          line.setAttribute('aria-hidden', 'true');
          railButton.append(line);
          railRow.append(railButton);
          railFragment.append(railRow);
        } else {
          railButton = this.railList.children[slotIndex].firstElementChild;
        }
        const railPrompt = this.items[promptIndexForRailSlot(
          slotIndex,
          count,
          this.items.length,
        )];
        railButton.dataset.messageId = railPrompt.id;
        railButton.dataset.slotIndex = String(slotIndex);
        railButton.tabIndex = this.open ? -1 : 0;
        railButton.setAttribute('aria-label', railPrompt.text);
      }

      if (replaceRail) this.railList.replaceChildren(railFragment);
      if (replaceRail) this.highlightedRailRow = null;
      const valid = new Set(this.items.map((item) => item.id));
      this.renderPanelEntries(this.hasSearchQuery() ? this.entries.filter(({ item }) => valid.has(item.id))
        : this.items.map((item) => ({ item, ranges: [] })));
    }

    appendHighlight(target, text, ranges, start, end) {
      let cursor = start;
      const append = (value, marked) => {
        if (!value) return;
        const span = document.createElement(marked ? 'mark' : 'span');
        span.textContent = value;
        target.append(span);
      };
      for (const range of ranges) {
        const a = Math.max(start, range.start);
        const b = Math.min(end, range.end);
        if (b <= a) continue;
        append(text.slice(cursor, a), false);
        append(text.slice(a, b), true);
        cursor = b;
      }
      append(text.slice(cursor, end), false);
    }

    previewMetrics() {
      const probe = this.previewProbe.firstElementChild;
      const style = getComputedStyle(probe);
      const button = getComputedStyle(this.previewProbe);
      const mark = getComputedStyle(probe.firstElementChild);
      const size = parseFloat(style.fontSize) || CONFIG.promptFontSizePx;
      const spacing = parseFloat(style.letterSpacing) || 0;
      const family = style.fontFamily || 'system-ui, sans-serif';
      const normalFont = `${style.fontWeight || 440} ${size}px ${family}`;
      const markedFont = `${mark.fontWeight || 600} ${size}px ${family}`;
      const leftPadding = parseFloat(button.paddingLeft);
      const rightPadding = parseFloat(button.paddingRight);
      const padding = (Number.isFinite(leftPadding) ? leftPadding : 8)
        + (Number.isFinite(rightPadding) ? rightPadding : 8);
      const panelWidth = this.panel.clientWidth || Math.min(CONFIG.panelWidthPx, (window.innerWidth || CONFIG.panelWidthPx + 40) - 40);
      if (this.previewContext === undefined) {
        try { this.previewContext = document.createElement('canvas').getContext?.('2d') ?? null; }
        catch { this.previewContext = null; }
      }
      const approximate = (value) => Array.from(value).reduce((total, character) => total
        + (/\p{M}|\u200D/u.test(character) ? 0 : /[^\u0000-\u00ff]/u.test(character) ? size : size * .54), 0);
      return {
        width: Math.max(24, panelWidth - 2 * CONFIG.panelPaddingPx - padding),
        measure: cachedPreviewMeasure((value, highlighted = false) => {
          if (!value) return 0;
          if (this.previewContext) {
            try {
              this.previewContext.font = highlighted ? markedFont : normalFont;
              return this.previewContext.measureText(value).width + spacing * Math.max(0, Array.from(value).length - 1);
            } catch { this.previewContext = null; }
          }
          return approximate(value);
        }),
      };
    }

    makePreview(item, ranges, metrics = null) {
      const preview = document.createElement('span');
      preview.className = `${NS}__preview`;
      if (!ranges.length) {
        preview.textContent = item.text;
        return preview;
      }
      const excerpt = searchPreview(item.text, ranges, metrics ?? this.previewMetrics());
      const appendEllipsis = (value) => {
        const span = document.createElement('span');
        span.textContent = value;
        preview.append(span);
      };
      if (excerpt.start > 0) appendEllipsis('… ');
      this.appendHighlight(preview, item.text, ranges, excerpt.start, excerpt.end);
      if (excerpt.end < item.text.length) appendEllipsis(' …');
      return preview;
    }

    refreshPreviews() {
      if (this.destroyed || !this.hasSearchQuery()) return;
      const metrics = this.previewMetrics();
      for (const { item, ranges } of this.entries) {
        if (!ranges.length) continue;
        this.panelById.get(item.id)?.firstElementChild
          ?.replaceChildren(this.makePreview(item, ranges, metrics));
      }
    }

    renderPanelEntries(entries) {
      const focusedId = this.shadow.activeElement?.dataset.messageId;
      this.entries = entries;
      const fragment = document.createDocumentFragment();
      const byId = new Map();
      const metrics = entries.some(({ ranges }) => ranges.length) ? this.previewMetrics() : null;
      for (const { item, ranges } of entries) {
        const row = document.createElement('li');
        row.className = `${NS}__panel-row`;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `${NS}__panel-item`;
        button.dataset.messageId = item.id;
        button.setAttribute('aria-label', item.text);
        button.append(this.makePreview(item, ranges, metrics));
        row.append(button);
        fragment.append(row);
        byId.set(item.id, row);
      }
      this.emptyNotice = null;
      if (!entries.length && this.query) {
        this.emptyNotice = document.createElement('li');
        this.emptyNotice.className = `${NS}__empty`;
        fragment.append(this.emptyNotice);
      }
      this.panelList.replaceChildren(fragment);
      this.panelById = byId;
      this.highlightedPanelRow = null;
      this.hoveredPanelRow = null;
      if (!byId.has(this.hoverId)) this.hoverId = null;
      this.applyVisuals();
      this.updateSearchNotice();
      if (focusedId && this.open) {
        if (byId.has(focusedId)) byId.get(focusedId).firstElementChild.focus({ preventScroll: true });
        else if (this.searchVisible) this.searchInput.focus({ preventScroll: true });
      }
    }

    panelAnchor() {
      const index = Math.max(0, Math.floor((this.panel.scrollTop - CONFIG.panelPaddingPx) / CONFIG.panelRowHeightPx));
      return { id: this.entries[index]?.item.id, offset: this.panel.scrollTop - index * CONFIG.panelRowHeightPx };
    }

    restorePanelAnchor(anchor) {
      const index = this.entries.findIndex(({ item }) => item.id === anchor?.id);
      this.panel.scrollTop = index >= 0 ? index * CONFIG.panelRowHeightPx + anchor.offset : 0;
    }

    revealSearchForPointer() {
      if (!this.open) return;
      this.pointerInSearch = true;
      this.cancelSearchRetraction();
      this.setSearchVisible(true);
      if (this.shadow.activeElement === this.searchInput) return;
      this.hoverFocus = { previous: this.shadow.activeElement ?? document.activeElement };
      this.searchInput.focus({ preventScroll: true });
    }

    releaseHoverFocus() {
      const previous = this.hoverFocus?.previous;
      const ownsFocus = this.hoverFocus && this.shadow.activeElement === this.searchInput;
      this.hoverFocus = null;
      if (!ownsFocus) return;
      this.searchInput.blur();
      if (previous?.isConnected && previous !== this.host && !this.dock.contains(previous)) {
        previous.focus?.({ preventScroll: true });
      }
    }

    startSearchSession() {
      this.searchSessionStarted = true;
      this.hoverFocus = null;
      this.cancelSearchRetraction();
    }

    cancelSearchRetraction() {
      window.clearTimeout(this.searchRetractTimer);
      this.searchRetractTimer = 0;
    }

    scheduleSearchRetraction() {
      this.cancelSearchRetraction();
      if (this.destroyed || !this.open || !this.searchVisible || this.searchSessionStarted) return;
      this.searchRetractTimer = window.setTimeout(() => {
        this.searchRetractTimer = 0;
        if (this.pointerInSearch || this.searchSessionStarted || this.composing) return;
        // Keyboard focus remains usable even when the mouse is elsewhere.
        // An unused pointer focus is transient and can be returned safely.
        if (this.searchField.contains(this.shadow.activeElement) && !this.hoverFocus) return;
        this.setSearchVisible(false);
      }, SEARCH.retractDelayMs);
    }

    setSearchVisible(visible, focus = false) {
      this.cancelSearchRetraction();
      this.searchVisible = visible;
      if (!visible) {
        this.releaseHoverFocus();
        if (this.searchField.contains(this.shadow.activeElement)) this.shadow.activeElement.blur();
      }
      focus ||= visible && this.shadow.activeElement === this.searchButton;
      this.searchShelf.classList.toggle(`${NS}__search-shelf--expanded`, visible);
      this.searchField.inert = !visible;
      this.searchField.setAttribute('aria-hidden', String(!visible));
      this.searchButton.tabIndex = visible ? -1 : 0;
      this.searchButton.setAttribute('aria-hidden', String(visible));
      this.searchButton.setAttribute('aria-expanded', String(visible));
      if (visible && focus) this.searchInput.focus({ preventScroll: true });
    }

    cancelSearch() {
      this.searchSequence += 1;
      this.searchController?.abort();
      this.searchController = null;
      this.searchSoon.cancel();
      this.searchPending = false;
    }

    hasSearchQuery() {
      return isSearchQuery(searchDocument(this.query));
    }

    setQuery(value) {
      value = String(value).slice(0, SEARCH.inputMaxLength);
      this.searchInput.value = value;
      const next = normalizeText(value);
      if (next === this.query) return;
      const wasSearching = this.hasSearchQuery();
      const willSearch = isSearchQuery(searchDocument(next));
      if (!wasSearching && willSearch) this.normalAnchor = this.panelAnchor();
      this.query = next;
      this.clearButton.hidden = !next;
      this.searchError = false;
      if (!willSearch) {
        this.cancelSearch();
        if (wasSearching) {
          this.renderPanelEntries(this.items.map((item) => ({ item, ranges: [] })));
          this.restorePanelAnchor(this.normalAnchor);
        }
        this.normalAnchor = null;
        this.updateSearchNotice();
      } else this.queueSearch();
    }

    queueSearch(preservePosition = false) {
      this.cancelSearch();
      this.preserveSearchPosition = preservePosition;
      this.searchPending = true;
      this.updateSearchNotice();
      this.searchSoon();
    }

    async runSearch() {
      if (!this.hasSearchQuery() || this.destroyed) return;
      const controller = new AbortController();
      this.searchController = controller;
      const sequence = this.searchSequence;
      try {
        const results = await this.search.find(this.query, controller.signal);
        if (this.destroyed || controller.signal.aborted || sequence !== this.searchSequence) return;
        const anchor = this.preserveSearchPosition ? this.panelAnchor() : null;
        this.searchPending = false;
        this.renderPanelEntries(results);
        this.restorePanelAnchor(anchor);
      } catch (error) {
        if (isAbortError(error) || this.destroyed || sequence !== this.searchSequence) return;
        this.searchPending = false;
        this.searchError = true;
        this.renderPanelEntries([]);
        console.warn(`[${NS}] Prompt search failed.`, error);
      } finally {
        if (this.searchController === controller) this.searchController = null;
      }
    }

    updateSearchNotice() {
      this.panel.setAttribute('aria-busy', String(this.searchPending || this.loadStatus === 'loading'));
      // Keep existing keyboard focus stable while results are recomputed.
      // Activation is guarded in the delegated click handler until ready.
      this.panelList.setAttribute('aria-busy', String(this.searchPending));
      if (!this.hasSearchQuery()) {
        if (this.announcer) this.announcer.textContent = '';
        return;
      }
      const incomplete = this.loadStatus === 'loading' || this.loadStatus === 'partial';
      const notice = this.searchPending ? 'Searching…' : this.searchError ? 'Search unavailable'
        : this.entries.length ? `${this.entries.length} matching ${this.entries.length === 1 ? 'prompt' : 'prompts'}`
          : incomplete ? 'No matches in loaded prompts' : 'No matching prompts';
      if (this.announcer) this.announcer.textContent = notice;
      if (this.emptyNotice) this.emptyNotice.textContent = notice;
    }

    visiblePanelRows() {
      const space = Math.max(1, window.innerHeight - 32 - 2 * SEARCH.shelfHeightPx - 2 * CONFIG.panelPaddingPx);
      return Math.max(1, Math.min(
        this.items.length,
        CONFIG.panelVisibleRows,
        Math.floor(space / CONFIG.panelRowHeightPx),
      ));
    }

    resize() {
      if (!this.items.length) return;
      const panelHeight = Math.max(
        CONFIG.triggerMinHeightPx,
        this.visiblePanelRows() * CONFIG.panelRowHeightPx + 2 * CONFIG.panelPaddingPx,
      );
      this.dock.style.setProperty(`--${NS}-panel-height`, `${panelHeight}px`);
      if (this.hasSearchQuery()) this.previewRefreshSoon();
    }

    setHover(messageId) {
      if (this.hoverId === messageId) return;
      this.hoverId = messageId;
      this.applyVisuals();
    }

    onWheel(event) {
      if (!this.open || event.ctrlKey) return;
      event.preventDefault();
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2
        ? this.panel.clientHeight : 1;
      this.panel.scrollTop += event.deltaY * multiplier;
    }

    applyVisuals() {
      const activeRailRow = this.railList.children[this.railSlot] ?? null;
      if (activeRailRow !== this.highlightedRailRow) {
        this.highlightedRailRow?.classList.remove(`${NS}__rail-row--active`);
        this.highlightedRailRow?.firstElementChild?.removeAttribute('aria-current');
        activeRailRow?.classList.add(`${NS}__rail-row--active`);
        activeRailRow?.firstElementChild?.setAttribute('aria-current', 'location');
        this.highlightedRailRow = activeRailRow;
      }

      const activePanelRow = this.panelById?.get(this.activeId) ?? null;
      if (activePanelRow !== this.highlightedPanelRow) {
        this.highlightedPanelRow?.classList.remove(`${NS}__panel-row--active`);
        this.highlightedPanelRow?.firstElementChild?.removeAttribute('aria-current');
        activePanelRow?.classList.add(`${NS}__panel-row--active`);
        activePanelRow?.firstElementChild?.setAttribute('aria-current', 'location');
        this.highlightedPanelRow = activePanelRow;
      }

      const hoveredPanelRow = this.open ? this.panelById?.get(this.hoverId) ?? null : null;
      if (hoveredPanelRow !== this.hoveredPanelRow) {
        this.hoveredPanelRow?.classList.remove(`${NS}__panel-row--hovered`);
        hoveredPanelRow?.classList.add(`${NS}__panel-row--hovered`);
        this.hoveredPanelRow = hoveredPanelRow;
      }
    }

    clear() {
      this.cancelSearchRetraction();
      this.searchSessionStarted = false;
      this.pointerInSearch = false;
      this.previewRefreshSoon.cancel();
      this.cancelSearch();
      this.query = '';
      this.searchError = false;
      this.composing = false;
      this.normalAnchor = null;
      this.signature = null;
      this.activeId = null;
      this.railSlot = -1;
      this.render([]);
    }

    destroy() {
      this.destroyed = true;
      this.cancelSearchRetraction();
      this.searchSessionStarted = false;
      this.releaseHoverFocus();
      this.previewRefreshSoon.cancel();
      document.fonts?.removeEventListener('loadingdone', this.onFontsReady);
      this.previewContext = null;
      this.cancelSearch();
      this.search.clear();
      window.clearTimeout(this.closeTimer);
      this.host.remove();
      this.entries = [];
      this.items = [];
      this.panelById?.clear();
    }
  }

  class ActiveTurnTracker {
    constructor(onActive) {
      this.onActive = onActive;
      this.observer = null;
      this.nodes = [];
      this.scroller = null;
      this.reverseScroller = false;
      this.scrollTarget = null;
      this.frame = 0;
      this.schedule = () => {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
          this.frame = 0;
          this.chooseActive();
        });
      };
    }

    disconnect() {
      this.observer?.disconnect();
      this.observer = null;
      this.scrollTarget?.removeEventListener('scroll', this.schedule);
      this.scrollTarget = null;
      this.scroller = null;
      this.reverseScroller = false;
      this.nodes = [];
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }

    sync(validIds) {
      this.disconnect();
      if (!validIds.size) return;

      this.nodes = DomTurns.all().filter((node) => validIds.has(node.getAttribute('data-turn-key')));
      if (!this.nodes.length) return;
      this.scroller = DomTurns.scroller(this.nodes[0]);
      this.reverseScroller = getComputedStyle(this.scroller).flexDirection === 'column-reverse';
      const root = this.scroller === document.scrollingElement ? null : this.scroller;
      if ('IntersectionObserver' in window) {
        this.observer = new IntersectionObserver(
          this.schedule,
          {
            root,
            rootMargin: `-${CONFIG.navigationTopOffsetPx}px 0px -68% 0px`,
            threshold: [0, 0.01],
          },
        );
        this.nodes.forEach((node) => this.observer.observe(node));
      }
      this.scrollTarget = root ?? window;
      this.scrollTarget.addEventListener('scroll', this.schedule, { passive: true });
      this.schedule();
    }

    chooseActive() {
      if (!this.nodes.length) return;
      const bottomDistance = this.reverseScroller
        ? Math.abs(this.scroller.scrollTop)
        : this.scroller.scrollHeight - this.scroller.clientHeight - this.scroller.scrollTop;
      if (bottomDistance <= CONFIG.bottomSnapPx) {
        // In the reverse thread, scrollTop is zero at the newest response.
        // Its user prompt can remain below the top anchor even at the bottom.
        const newest = this.nodes.at(-1);
        if (newest?.isConnected === false || !this.scroller.contains(newest)) return;
        const id = newest?.getAttribute('data-turn-key');
        if (id) this.onActive(id);
        return;
      }
      const rootTop = this.scroller && this.scroller !== document.scrollingElement
        ? this.scroller.getBoundingClientRect().top
        : 0;
      const anchor = rootTop + CONFIG.navigationTopOffsetPx + 2;

      // Turns are in DOM order. Binary search cached nodes so a scroll frame
      // reads only a handful of rectangles even when every turn is mounted.
      let low = 0;
      let high = this.nodes.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        const candidate = this.nodes[middle];
        if (candidate.isConnected === false) return;
        if (candidate.getBoundingClientRect().top <= anchor) low = middle + 1;
        else high = middle;
      }
      const node = this.nodes[Math.max(0, low - 1)];
      if (node?.isConnected === false) return;
      if (this.scroller?.contains && !this.scroller.contains(node)) return;
      const id = node?.getAttribute('data-turn-key');
      if (id) this.onActive(id);
    }
  }

  class PromptCache {
    constructor(limit) {
      this.limit = limit;
      this.map = new Map();
    }

    get(key) {
      const value = this.map.get(key);
      if (!value) return null;
      this.map.delete(key);
      this.map.set(key, value);
      return value;
    }

    set(key, value) {
      this.map.delete(key);
      this.map.set(key, value.slice());
      while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    }
  }

  class App {
    constructor() {
      this.request = new ChatGPTRequest();
      this.source = new ConversationSource(this.request);
      this.cache = new PromptCache(CONFIG.cacheConversationLimit);
      this.view = new TocView((id) => this.navigate(id), () => this.recoverData());
      this.activeTracker = new ActiveTurnTracker((id) => this.view.setActive(id));
      this.context = null;
      this.sourceItems = [];
      this.items = [];
      this.loadController = null;
      this.loadSequence = 0;
      this.loadState = 'idle';
      this.hasCompleteIndex = false;
      this.checkpoint = null;
      this.loadError = null;
      this.retryAvailableAt = 0;
      this.destroyed = false;
      this.started = false;
      this.navigationFrame = 0;
      this.domReady = true;
      this.staleDomSignature = '';
      this.lastRefreshMismatch = '';
      this.lastHref = location.href;
      this.pendingNavigation = readPendingNavigation();

      this.reconcileSoon = createDebouncer(() => this.reconcileDom(), CONFIG.domReconcileDelayMs);
      this.refreshSoon = createDebouncer(() => this.refreshData(), CONFIG.dataRefreshDelayMs);
      this.routeSoon = createDebouncer(() => this.checkRoute(), 0);
      this.onRoute = () => this.routeSoon();
      this.onResize = () => this.view.resize();
      this.onOnline = () => this.recoverData(true);
      this.onVisibility = () => {
        if (document.visibilityState === 'visible') this.recoverData();
      };
    }

    start() {
      if (this.started || this.destroyed) return;
      this.started = true;
      patchHistoryEvents();
      window.addEventListener(ROUTE_EVENT, this.onRoute);
      window.addEventListener('popstate', this.onRoute);
      window.addEventListener('hashchange', this.onRoute);
      window.addEventListener('resize', this.onResize, { passive: true });
      window.addEventListener('online', this.onOnline);
      document.addEventListener('visibilitychange', this.onVisibility);

      this.mutations = new MutationObserver((records) => this.onMutations(records));
      this.mutations.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          'data-turn-key',
          'data-chatgpt-search-unit-key',
          'data-content-search-unit-key',
          'data-chatgpt-search-message-ids',
        ],
      });

      this.checkRoute(true);
    }

    checkRoute(initial = false) {
      if (this.destroyed) return;
      this.lastHref = location.href;
      const next = routeContext();
      if (next?.key === this.context?.key) return;

      const previousSignature = DomTurns.signature();
      this.loadController?.abort();
      this.loadController = null;
      this.loadSequence += 1;
      this.reconcileSoon.cancel();
      this.refreshSoon.cancel();
      cancelAnimationFrame(this.navigationFrame);
      this.navigationFrame = 0;
      this.lastRefreshMismatch = '';
      this.activeTracker.disconnect();
      this.context = next;
      this.sourceItems = [];
      this.items = [];
      this.loadState = 'idle';
      this.hasCompleteIndex = false;
      this.checkpoint = null;
      this.loadError = null;
      this.retryAvailableAt = 0;
      this.view.clear();
      this.view.setStatus('idle');

      if (!next) return;

      if (
        this.pendingNavigation
        && this.pendingNavigation.conversationId !== next.conversationId
      ) {
        this.pendingNavigation = null;
        forgetPendingNavigation();
      }

      this.staleDomSignature = previousSignature;
      this.domReady = initial || !previousSignature;
      const cached = this.cache.get(next.key);
      if (cached) {
        this.sourceItems = cached;
        this.hasCompleteIndex = true;
        this.renderCurrent();
      }

      if (this.domReady) this.reconcileDom();
      return this.refreshData();
    }

    onMutations(records) {
      if (this.destroyed) return;
      if (location.href !== this.lastHref) this.routeSoon();

      let relevant = false;
      for (const record of records) {
        if (record.type === 'attributes') {
          const target = /** @type {Element} */ (record.target);
          if (
            target.matches?.(`${SELECTOR.turn},${USER_UNIT_SELECTOR}`)
            || target.closest?.(USER_UNIT_SELECTOR)
          ) {
            relevant = true;
            break;
          }
          continue;
        }

        if (record.type === 'characterData') {
          if (record.target.parentElement?.closest(USER_UNIT_SELECTOR)) {
            relevant = true;
            break;
          }
          continue;
        }

        if (record.target instanceof Element && record.target.closest(USER_UNIT_SELECTOR)) {
          relevant = true;
          break;
        }

        const changed = [...record.addedNodes, ...record.removedNodes];
        for (const node of changed) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const element = /** @type {Element} */ (node);
          if (
            element.matches?.(`${SELECTOR.turn},${USER_UNIT_SELECTOR}`)
            || element.querySelector?.(`${SELECTOR.turn},${USER_UNIT_SELECTOR}`)
          ) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;
      }

      if (!relevant) return;
      // A scroll event can arrive between ChatGPT removing an old page of
      // turns and mounting the new one. Hold the previous location until the
      // debounced reconciliation has a coherent set of connected nodes.
      this.activeTracker.disconnect();
      this.reconcileSoon();
    }

    reconcileDom() {
      if (this.destroyed || !this.context) return;
      const signature = DomTurns.signature();
      if (!this.domReady) {
        if (signature === this.staleDomSignature) return;
        this.domReady = true;
      }
      const rendered = this.renderCurrent();
      this.maybeRefreshData(rendered);
    }

    renderCurrent() {
      const rendered = this.domReady ? DomTurns.prompts() : [];
      this.items = mergeRenderedPrompts(this.sourceItems, rendered);
      this.view.render(this.items);
      this.view.setStatus(this.loadState);
      this.activeTracker.sync(new Set(this.items.map((item) => item.id)));
      this.finishPendingNavigation();
      return rendered;
    }

    maybeRefreshData(rendered = DomTurns.prompts()) {
      if (this.destroyed || !this.context || this.loadController) return;
      // Exhausted reads recover on explicit interaction/connectivity events,
      // not on every host mutation. This prevents token streams/re-renders
      // from turning bounded HTTP retries into an unbounded retry loop.
      if (this.loadState !== 'complete' || this.loadError || this.checkpoint) return;
      const sourceText = new Map(this.sourceItems.map((item) => [item.id, item.text]));
      const mismatch = rendered
        .filter((item) => (
          !sourceText.has(item.id)
          || (sourceText.get(item.id) !== item.text && !sourceText.get(item.id).startsWith(item.text))
        ))
        .map((item) => `${item.id}\u0000${item.text}`)
        .join('\u0001');
      if (!mismatch) {
        this.lastRefreshMismatch = '';
        return;
      }
      if (mismatch === this.lastRefreshMismatch) return;
      this.lastRefreshMismatch = mismatch;
      this.refreshSoon();
    }

    recoverData(online = false) {
      if (this.destroyed || !this.context || this.loadController || !this.loadError) return;
      if (!isTransientError(this.loadError)) return;
      // A connectivity change can bypass our cooldown, but never Retry-After.
      const cause = this.loadError.cause ?? this.loadError;
      const serverWait = this.failedAt + (cause.retryAfterMs ?? 0);
      if (Date.now() < serverWait || (!online && Date.now() < this.retryAvailableAt)) return;
      return this.refreshData();
    }

    finishPendingNavigation() {
      const pending = this.pendingNavigation;
      if (!pending || pending.conversationId !== this.context?.conversationId) return;
      if (pending.expiresAt <= Date.now()) {
        this.pendingNavigation = null;
        forgetPendingNavigation();
        return;
      }
      if (!DomTurns.find(pending.messageId)) return;

      this.pendingNavigation = null;
      forgetPendingNavigation();
      this.view.setActive(pending.messageId);
      cancelAnimationFrame(this.navigationFrame);
      this.navigationFrame = requestAnimationFrame(() => {
        this.navigationFrame = 0;
        if (!this.destroyed && pending.conversationId === this.context?.conversationId) {
          DomTurns.scrollTo(pending.messageId);
        }
      });
    }

    async refreshData() {
      const context = this.context;
      if (this.destroyed || !context || this.loadController) return;
      this.refreshSoon.cancel();

      const controller = new AbortController();
      this.loadController = controller;
      const sequence = ++this.loadSequence;
      const stillCurrent = () => (
        !this.destroyed && !controller.signal.aborted
        && sequence === this.loadSequence
        && context.key === this.context?.key
      );
      this.loadState = 'loading';
      this.loadError = null;
      this.publishingPages = !this.hasCompleteIndex;
      this.view.setStatus(this.loadState);

      try {
        const result = await this.source.load(context, controller.signal, (progress) => {
          if (!stillCurrent()) return;
          this.checkpoint = progress.checkpoint;
          // During a fresh read, do not replace a previously complete cache
          // with its recent page. Publish every useful validated older page
          // on first load; publish the replacement atomically when complete.
          if (!this.sourceItems.length || this.publishingPages || progress.status === 'complete') {
            this.publishingPages = true;
            this.sourceItems = progress.items;
          }
          this.renderCurrent();
        }, this.checkpoint);
        if (!stillCurrent()) return;
        this.sourceItems = result.items;
        this.checkpoint = result.checkpoint;
        this.loadState = result.status;
        if (result.status === 'complete') {
          this.hasCompleteIndex = true;
          this.cache.set(context.key, result.items);
        }
        this.renderCurrent();
      } catch (error) {
        if (!isAbortError(error) && stillCurrent()) {
          this.checkpoint = error.checkpoint ?? this.checkpoint;
          this.loadError = error;
          this.failedAt = Date.now();
          this.retryAvailableAt = this.failedAt + CONFIG.recoveryCooldownMs;
          this.loadState = this.items.length || this.sourceItems.length ? 'partial' : 'unavailable';
          this.renderCurrent();
        }
      } finally {
        if (sequence === this.loadSequence) {
          this.loadController = null;
          this.publishingPages = false;
          if (stillCurrent()) this.maybeRefreshData();
        }
      }
    }

    navigate(messageId) {
      if (this.destroyed) return;
      this.view.setActive(messageId);
      if (DomTurns.scrollTo(messageId)) return;

      // ChatGPT's own route loader accepts this parameter, loads the page that
      // contains the message, scrolls to it, and then canonicalizes the URL.
      const url = new URL(location.href);
      url.searchParams.set('message', messageId);
      if (this.context) rememberPendingNavigation(this.context, messageId);
      location.assign(url.href);
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.loadSequence += 1;
      this.loadController?.abort();
      this.loadController = null;
      this.mutations?.disconnect();
      this.activeTracker.disconnect();
      this.reconcileSoon.cancel();
      this.refreshSoon.cancel();
      this.routeSoon.cancel();
      cancelAnimationFrame(this.navigationFrame);
      window.removeEventListener(ROUTE_EVENT, this.onRoute);
      window.removeEventListener('popstate', this.onRoute);
      window.removeEventListener('hashchange', this.onRoute);
      window.removeEventListener('resize', this.onResize);
      window.removeEventListener('online', this.onOnline);
      document.removeEventListener('visibilitychange', this.onVisibility);
      this.view.destroy();
      this.cache.map.clear();
      this.items = [];
      this.sourceItems = [];
      this.checkpoint = null;
      this.context = null;
      this.request.token = null;
      if (window[INSTANCE_KEY] === this) delete window[INSTANCE_KEY];
      // Keep the shared History wrapper: removing it could break wrappers
      // installed later by ChatGPT or another personal userscript.
    }
  }

  function bootstrap() {
    window[INSTANCE_KEY]?.destroy();
    const app = new App();
    window[INSTANCE_KEY] = app;
    app.start();
  }

  if (document.body) bootstrap();
}());
