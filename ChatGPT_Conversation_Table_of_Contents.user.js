// ==UserScript==
// @name         ChatGPT Conversation Table of Contents
// @namespace    https://github.com/TacticalOriental/ChatGPT_Conversation_Table_of_Contents
// @version      2.0.0
// @description  A quiet, native-feeling prompt index for every ChatGPT conversation.
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

      this.dock.append(this.panel, this.rail);
      this.shadow.append(this.dock);
      this.bindEvents();
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
          border: 1px solid color-mix(
            in srgb, var(--color-text-primary, #0d0d0d) 8%, transparent
          );
          border-radius: 12px;
          background: color-mix(
            in srgb,
            var(
              --color-surface-elevated-secondary,
              var(--color-token-main-surface-primary, #fff)
            ) 97%,
            transparent
          );
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

        @media (prefers-reduced-motion: reduce) {
          .${NS}__rail, .${NS}__line, .${NS}__panel,
          .${NS}__panel-item { transition: none; }
        }
      `;
    }

    bindEvents() {
      this.dock.addEventListener('pointerenter', () => {
        this.pointerInside = true;
        window.clearTimeout(this.closeTimer);
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
        if (!this.dock.contains(event.relatedTarget)) {
          this.scheduleClose();
        }
      });

      this.dock.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });

      this.dock.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        this.setOpen(false);
        this.shadow.activeElement?.blur();
      });

      this.dock.addEventListener('click', (event) => {
        const button = event.target.closest?.(`.${NS}__rail-item, .${NS}__panel-item`);
        const id = button?.dataset.messageId;
        if (!id) return;
        this.setActive(id);
        this.setOpen(false);
        this.onNavigate(id);
      });
    }

    scheduleClose() {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = window.setTimeout(() => {
        this.closeTimer = 0;
        if (!this.pointerInside && !this.dock.contains(this.shadow.activeElement)) this.setOpen(false);
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
      this.panel.setAttribute('aria-busy', String(status === 'loading'));
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
      this.dock.classList.toggle(`${NS}__dock--open`, open);
      for (const row of this.railList.children) row.firstElementChild.tabIndex = open ? -1 : 0;
      if (!open) {
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
      const topIndex = Math.floor(this.panel.scrollTop / CONFIG.panelRowHeightPx);
      const topId = this.items[topIndex]?.id;
      const topOffset = this.panel.scrollTop % CONFIG.panelRowHeightPx;
      this.items = items.slice();

      if (!this.items.length) {
        this.railList.replaceChildren();
        this.panelList.replaceChildren();
        this.panel.scrollTop = 0;
        this.panelById = new Map();
        this.highlightedPanelRow = null;
        this.hoveredPanelRow = null;
        this.highlightedRailRow = null;
        this.host.hidden = true;
        this.setOpen(false);
        return;
      }

      // Slots belong to this index revision. A slot from a partial list must
      // not constrain the same message after an older prefix is discovered.
      this.railSlot = this.slotForActive();

      this.host.hidden = false;
      this.renderEntries();
      if (topId) {
        const nextIndex = this.indexOf(topId);
        this.panel.scrollTop = nextIndex >= 0
          ? nextIndex * CONFIG.panelRowHeightPx + topOffset
          : 0;
      }
      if (this.open && focusedId && this.panelById.has(focusedId)) {
        this.ensurePromptVisible(this.indexOf(focusedId));
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
      const panelFragment = document.createDocumentFragment();
      const panelById = new Map();

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

      for (const item of this.items) {
        const panelRow = document.createElement('li');
        panelRow.className = `${NS}__panel-row`;
        const panelButton = document.createElement('button');
        panelButton.type = 'button';
        panelButton.className = `${NS}__panel-item`;
        panelButton.dataset.messageId = item.id;
        panelButton.setAttribute('aria-label', item.text);
        const preview = document.createElement('span');
        preview.className = `${NS}__preview`;
        preview.textContent = item.text;
        panelButton.append(preview);
        panelRow.append(panelButton);
        panelFragment.append(panelRow);
        panelById.set(item.id, panelRow);
      }

      if (replaceRail) this.railList.replaceChildren(railFragment);
      this.panelList.replaceChildren(panelFragment);
      this.panelById = panelById;
      this.highlightedPanelRow = null;
      this.hoveredPanelRow = null;
      if (replaceRail) this.highlightedRailRow = null;
      if (!panelById.has(this.hoverId)) this.hoverId = null;
      this.applyVisuals();
    }

    visiblePanelRows() {
      const space = Math.max(1, window.innerHeight - 32 - 2 * CONFIG.panelPaddingPx);
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
    }

    setHover(messageId) {
      if (this.hoverId === messageId) return;
      this.hoverId = messageId;
      this.applyVisuals();
    }

    onWheel(event) {
      if (!this.open || this.items.length <= 1) return;
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
      this.signature = null;
      this.activeId = null;
      this.railSlot = -1;
      this.render([]);
    }

    destroy() {
      window.clearTimeout(this.closeTimer);
      this.host.remove();
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
