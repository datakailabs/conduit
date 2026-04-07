/**
 * Conduit Chat Widget — Embeddable knowledge graph chat.
 *
 * Usage (script tag):
 *   <script src="https://your-conduit/static/widget/conduit-chat.js"
 *     data-api="https://your-conduit/api/v1"
 *     data-key="your-api-key"
 *     data-title="Ask anything"
 *     data-accent="#0ea5e9"
 *     data-position="bottom-right"
 *     data-mode="standard"
 *     data-suggestions="What is Snowflake?|How does Iceberg work?|Compare Spark vs Flink"
 *     data-persist="true">
 *   </script>
 *
 * Programmatic:
 *   ConduitChat.init({
 *     api: 'https://your-conduit/api/v1',
 *     key: 'cnd_...',
 *     title: 'Ask anything',
 *     accent: '#0ea5e9',
 *     suggestions: ['What is Snowflake?', 'How does Iceberg work?'],
 *     persist: true,
 *   });
 *
 * API: ConduitChat.{ init, destroy, open, close, toggle, ask, clearHistory }
 */
(function () {
  'use strict';

  // ─── Configuration ────────────────────────────────────────────────

  const DEFAULTS = {
    api: '',
    key: '',
    title: 'Ask Conduit',
    subtitle: 'Knowledge-powered answers',
    placeholder: 'Ask a question...',
    accent: '#0ea5e9',
    position: 'bottom-right',
    mode: 'standard',
    greeting: 'Hi! Ask me anything and I\'ll search the knowledge graph for answers.',
    suggestions: [],  // Array of suggested question strings
    persist: false,    // Save chat history to localStorage
    width: '400px',
    height: '560px',
    zIndex: 9999,
  };

  let config = { ...DEFAULTS };
  let state = {
    open: false,
    messages: [],
    loading: false,
  };
  let root = null;

  // ─── Styles ───────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('conduit-chat-styles')) return;

    const style = document.createElement('style');
    style.id = 'conduit-chat-styles';
    style.textContent = `
      #conduit-chat-root {
        --cc-accent: ${config.accent};
        --cc-accent-hover: color-mix(in srgb, ${config.accent} 85%, black);
        --cc-bg: #ffffff;
        --cc-bg-secondary: #f8fafc;
        --cc-bg-user: var(--cc-accent);
        --cc-bg-bot: #f1f5f9;
        --cc-text: #1e293b;
        --cc-text-secondary: #64748b;
        --cc-text-user: #ffffff;
        --cc-text-bot: #1e293b;
        --cc-border: #e2e8f0;
        --cc-shadow: 0 20px 60px rgba(0,0,0,0.15), 0 8px 20px rgba(0,0,0,0.08);
        --cc-radius: 16px;
        --cc-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-family: var(--cc-font);
        position: fixed;
        z-index: ${config.zIndex};
        ${config.position.includes('right') ? 'right: 20px;' : 'left: 20px;'}
        ${config.position.includes('bottom') ? 'bottom: 20px;' : 'top: 20px;'}
      }

      @media (prefers-color-scheme: dark) {
        #conduit-chat-root.cc-auto-dark {
          --cc-bg: #0f172a;
          --cc-bg-secondary: #1e293b;
          --cc-bg-bot: #1e293b;
          --cc-text: #e2e8f0;
          --cc-text-secondary: #94a3b8;
          --cc-text-bot: #e2e8f0;
          --cc-border: #334155;
          --cc-shadow: 0 20px 60px rgba(0,0,0,0.4), 0 8px 20px rgba(0,0,0,0.2);
        }
      }

      /* ─── Toggle Button ─────────────────────────────────────── */

      .cc-toggle {
        width: 56px; height: 56px;
        border-radius: 50%;
        background: var(--cc-accent);
        color: white;
        border: none;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 16px rgba(0,0,0,0.2);
        transition: transform 0.2s, box-shadow 0.2s;
      }
      .cc-toggle:hover {
        transform: scale(1.08);
        box-shadow: 0 6px 24px rgba(0,0,0,0.25);
      }
      .cc-toggle svg {
        width: 26px; height: 26px;
        transition: transform 0.3s;
      }
      .cc-toggle.cc-open svg { transform: rotate(90deg); }

      /* ─── Panel ─────────────────────────────────────────────── */

      .cc-panel {
        position: absolute;
        ${config.position.includes('bottom') ? 'bottom: 70px;' : 'top: 70px;'}
        ${config.position.includes('right') ? 'right: 0;' : 'left: 0;'}
        width: ${config.width};
        height: ${config.height};
        max-height: calc(100vh - 120px);
        background: var(--cc-bg);
        border-radius: var(--cc-radius);
        box-shadow: var(--cc-shadow);
        border: 1px solid var(--cc-border);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        opacity: 0;
        transform: translateY(12px) scale(0.96);
        pointer-events: none;
        transition: opacity 0.25s ease, transform 0.25s ease;
      }
      .cc-panel.cc-visible {
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
      }

      /* ─── Header ────────────────────────────────────────────── */

      .cc-header {
        padding: 16px 20px;
        background: var(--cc-bg);
        border-bottom: 1px solid var(--cc-border);
        display: flex;
        align-items: center;
        gap: 12px;
        flex-shrink: 0;
      }
      .cc-header-icon {
        width: 36px; height: 36px;
        background: var(--cc-accent);
        border-radius: 10px;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      .cc-header-icon svg { width: 20px; height: 20px; color: white; }
      .cc-header-text h3 {
        margin: 0; font-size: 15px; font-weight: 600;
        color: var(--cc-text);
      }
      .cc-header-text p {
        margin: 2px 0 0; font-size: 12px;
        color: var(--cc-text-secondary);
      }

      /* ─── Messages ──────────────────────────────────────────── */

      .cc-messages {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        scroll-behavior: smooth;
      }
      .cc-messages::-webkit-scrollbar { width: 4px; }
      .cc-messages::-webkit-scrollbar-thumb {
        background: var(--cc-border); border-radius: 4px;
      }

      .cc-msg {
        max-width: 85%;
        padding: 10px 14px;
        border-radius: 14px;
        font-size: 14px;
        line-height: 1.5;
        word-wrap: break-word;
        white-space: pre-wrap;
      }
      .cc-msg a {
        color: inherit;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .cc-msg-user {
        align-self: flex-end;
        background: var(--cc-bg-user);
        color: var(--cc-text-user);
        border-bottom-right-radius: 4px;
      }
      .cc-msg-bot {
        align-self: flex-start;
        background: var(--cc-bg-bot);
        color: var(--cc-text-bot);
        border-bottom-left-radius: 4px;
      }
      .cc-msg-greeting {
        align-self: flex-start;
        background: var(--cc-bg-bot);
        color: var(--cc-text-bot);
        border-bottom-left-radius: 4px;
        font-size: 13px;
      }

      /* Sources */
      .cc-sources {
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid var(--cc-border);
        font-size: 11px;
        color: var(--cc-text-secondary);
      }
      .cc-sources-label {
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
      }
      .cc-source-item {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 0;
      }
      .cc-source-dot {
        width: 5px; height: 5px;
        border-radius: 50%;
        background: var(--cc-accent);
        flex-shrink: 0;
      }
      .cc-source-title {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* Loading */
      .cc-loading {
        align-self: flex-start;
        display: flex;
        gap: 4px;
        padding: 14px 18px;
        background: var(--cc-bg-bot);
        border-radius: 14px;
        border-bottom-left-radius: 4px;
      }
      .cc-dot {
        width: 7px; height: 7px;
        border-radius: 50%;
        background: var(--cc-text-secondary);
        animation: cc-bounce 1.4s ease-in-out infinite;
      }
      .cc-dot:nth-child(2) { animation-delay: 0.16s; }
      .cc-dot:nth-child(3) { animation-delay: 0.32s; }
      @keyframes cc-bounce {
        0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
        40% { transform: scale(1); opacity: 1; }
      }

      /* ─── Input ─────────────────────────────────────────────── */

      .cc-input-area {
        padding: 12px 16px;
        border-top: 1px solid var(--cc-border);
        background: var(--cc-bg);
        display: flex;
        gap: 8px;
        align-items: flex-end;
        flex-shrink: 0;
      }
      .cc-input {
        flex: 1;
        border: 1px solid var(--cc-border);
        border-radius: 12px;
        padding: 10px 14px;
        font-size: 14px;
        font-family: var(--cc-font);
        background: var(--cc-bg-secondary);
        color: var(--cc-text);
        outline: none;
        resize: none;
        max-height: 100px;
        line-height: 1.4;
      }
      .cc-input::placeholder { color: var(--cc-text-secondary); }
      .cc-input:focus { border-color: var(--cc-accent); }

      .cc-send {
        width: 38px; height: 38px;
        border-radius: 10px;
        background: var(--cc-accent);
        color: white;
        border: none;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
        transition: background 0.15s, transform 0.1s;
      }
      .cc-send:hover { background: var(--cc-accent-hover); }
      .cc-send:active { transform: scale(0.94); }
      .cc-send:disabled { opacity: 0.5; cursor: default; transform: none; }
      .cc-send svg { width: 18px; height: 18px; }

      /* ─── Powered by ────────────────────────────────────────── */

      .cc-powered {
        text-align: center;
        padding: 6px;
        font-size: 10px;
        color: var(--cc-text-secondary);
        background: var(--cc-bg);
        border-top: 1px solid var(--cc-border);
        flex-shrink: 0;
      }
      .cc-powered a {
        color: var(--cc-text-secondary);
        text-decoration: none;
        font-weight: 500;
      }
      .cc-powered a:hover { text-decoration: underline; }

      /* ─── Suggestions ────────────────────────────────────────── */

      .cc-suggestions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 0 16px 8px;
      }
      .cc-suggestion {
        background: var(--cc-bg-secondary);
        border: 1px solid var(--cc-border);
        border-radius: 12px;
        padding: 6px 12px;
        font-size: 12px;
        color: var(--cc-text);
        cursor: pointer;
        font-family: var(--cc-font);
        transition: background 0.15s, border-color 0.15s;
      }
      .cc-suggestion:hover {
        background: color-mix(in srgb, var(--cc-accent) 10%, var(--cc-bg));
        border-color: var(--cc-accent);
      }

      /* ─── Mobile ────────────────────────────────────────────── */

      @media (max-width: 480px) {
        .cc-panel {
          width: calc(100vw - 24px);
          height: calc(100vh - 100px);
          right: 12px !important;
          left: 12px !important;
          bottom: 78px !important;
          border-radius: 14px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // ─── Icons ────────────────────────────────────────────────────────

  const ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  const ICON_GRAPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><line x1="8.5" y1="7.5" x2="15.5" y2="16.5"/><line x1="15.5" y1="7.5" x2="8.5" y2="16.5"/></svg>';

  // ─── Rendering ────────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderMessage(msg) {
    if (msg.type === 'greeting') {
      return `<div class="cc-msg cc-msg-greeting">${escapeHtml(msg.text)}</div>`;
    }

    if (msg.type === 'user') {
      return `<div class="cc-msg cc-msg-user">${escapeHtml(msg.text)}</div>`;
    }

    // Bot message with optional sources
    let html = `<div class="cc-msg cc-msg-bot">${escapeHtml(msg.text)}`;
    if (msg.sources && msg.sources.length > 0) {
      html += '<div class="cc-sources">';
      html += '<div class="cc-sources-label">Sources</div>';
      const shown = msg.sources.slice(0, 5);
      for (const src of shown) {
        const title = escapeHtml(src.title || src.id || 'Unknown');
        html += `<div class="cc-source-item"><span class="cc-source-dot"></span><span class="cc-source-title" title="${title}">${title}</span></div>`;
      }
      if (msg.sources.length > 5) {
        html += `<div class="cc-source-item" style="opacity:0.7">+ ${msg.sources.length - 5} more</div>`;
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function render() {
    if (!root) return;

    const toggle = root.querySelector('.cc-toggle');
    const panel = root.querySelector('.cc-panel');
    const messagesEl = root.querySelector('.cc-messages');

    // Toggle button icon
    toggle.innerHTML = state.open ? ICON_CLOSE : ICON_CHAT;
    toggle.classList.toggle('cc-open', state.open);

    // Panel visibility
    panel.classList.toggle('cc-visible', state.open);

    // Messages
    let html = '';
    for (const msg of state.messages) {
      html += renderMessage(msg);
    }
    // Show suggestion chips after greeting, before any user messages
    const hasUserMessages = state.messages.some(m => m.type === 'user');
    if (!hasUserMessages && config.suggestions.length > 0) {
      html += '<div class="cc-suggestions">';
      for (const s of config.suggestions) {
        html += `<button class="cc-suggestion" data-query="${escapeHtml(s)}">${escapeHtml(s)}</button>`;
      }
      html += '</div>';
    }
    if (state.loading) {
      html += '<div class="cc-loading"><div class="cc-dot"></div><div class="cc-dot"></div><div class="cc-dot"></div></div>';
    }
    messagesEl.innerHTML = html;

    // Bind suggestion click handlers
    messagesEl.querySelectorAll('.cc-suggestion').forEach(btn => {
      btn.addEventListener('click', () => {
        const q = btn.getAttribute('data-query');
        const input = root.querySelector('.cc-input');
        if (input) input.value = '';
        sendMessage(q);
      });
    });

    // Scroll to bottom
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Focus input when opening
    if (state.open) {
      const input = root.querySelector('.cc-input');
      if (input) setTimeout(() => input.focus(), 100);
    }
  }

  // ─── API ──────────────────────────────────────────────────────────

  async function sendMessage(text) {
    if (!text.trim() || state.loading) return;

    state.messages.push({ type: 'user', text: text.trim() });
    state.loading = true;
    render();

    const useStream = config.mode !== 'swarm';

    try {
      const res = await fetch(config.api + '/ask', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + config.key,
        },
        body: JSON.stringify({
          query: text.trim(),
          mode: config.mode,
          stream: useStream,
          limit: 8,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      if (useStream) {
        await handleStream(res);
      } else {
        const data = await res.json();
        state.messages.push({
          type: 'bot',
          text: data.answer || 'No answer available.',
          sources: data.sources || [],
          mode: data.mode,
        });
      }
    } catch (err) {
      // If streaming left a partial message, mark it as errored
      const last = state.messages[state.messages.length - 1];
      if (last && last._streaming) {
        delete last._streaming;
        if (!last.text) last.text = 'Sorry, something went wrong. Please try again.';
      } else {
        state.messages.push({
          type: 'bot',
          text: 'Sorry, something went wrong. Please try again.',
          error: true,
        });
      }
      console.error('[ConduitChat]', err);
    }

    state.loading = false;
    if (config.persist) saveHistory();
    render();
  }

  function saveHistory() {
    try {
      const key = 'conduit-chat-' + (config.persistKey || 'default');
      const data = state.messages.filter(m => m.type !== 'greeting' && !m._streaming);
      localStorage.setItem(key, JSON.stringify(data));
    } catch (_) { /* localStorage unavailable */ }
  }

  function loadHistory() {
    try {
      const key = 'conduit-chat-' + (config.persistKey || 'default');
      const raw = localStorage.getItem(key);
      if (raw) {
        const msgs = JSON.parse(raw);
        if (Array.isArray(msgs) && msgs.length > 0) return msgs;
      }
    } catch (_) { /* localStorage unavailable */ }
    return [];
  }

  async function handleStream(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let botMsg = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

      let eventType = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7);
        } else if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));

          if (eventType === 'retrieval') {
            // Create the bot message placeholder with sources
            state.loading = false;
            botMsg = { type: 'bot', text: '', sources: data.sources || [], _streaming: true };
            state.messages.push(botMsg);
            render();
          } else if (eventType === 'token' && botMsg) {
            botMsg.text += data.token;
            render();
          } else if (eventType === 'done' && botMsg) {
            delete botMsg._streaming;
            botMsg.mode = data.mode;
          } else if (eventType === 'error') {
            if (botMsg) {
              delete botMsg._streaming;
              botMsg.text = 'Sorry, something went wrong. Please try again.';
              botMsg.error = true;
            }
          }
          eventType = '';
        }
      }
    }
  }

  // ─── DOM Construction ─────────────────────────────────────────────

  function mount() {
    injectStyles();

    root = document.createElement('div');
    root.id = 'conduit-chat-root';
    root.classList.add('cc-auto-dark');

    root.innerHTML = `
      <div class="cc-panel">
        <div class="cc-header">
          <div class="cc-header-icon">${ICON_GRAPH}</div>
          <div class="cc-header-text">
            <h3>${escapeHtml(config.title)}</h3>
            <p>${escapeHtml(config.subtitle)}</p>
          </div>
        </div>
        <div class="cc-messages"></div>
        <div class="cc-input-area">
          <textarea class="cc-input" placeholder="${escapeHtml(config.placeholder)}" rows="1"></textarea>
          <button class="cc-send" title="Send">${ICON_SEND}</button>
        </div>
        <div class="cc-powered">Powered by <a href="https://github.com/datakailabs/conduit" target="_blank" rel="noopener">Conduit</a></div>
      </div>
      <button class="cc-toggle" title="Chat">${ICON_CHAT}</button>
    `;

    document.body.appendChild(root);

    // ─── Event Handlers ───────────────────────────────────────────

    const toggle = root.querySelector('.cc-toggle');
    const input = root.querySelector('.cc-input');
    const send = root.querySelector('.cc-send');

    toggle.addEventListener('click', () => {
      state.open = !state.open;
      render();
    });

    send.addEventListener('click', () => {
      sendMessage(input.value);
      input.value = '';
      input.style.height = 'auto';
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(input.value);
        input.value = '';
        input.style.height = 'auto';
      }
    });

    // Auto-resize textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 100) + 'px';
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.open) {
        state.open = false;
        render();
      }
    });

    // Restore history or show greeting
    const history = config.persist ? loadHistory() : [];
    if (history.length > 0) {
      if (config.greeting) {
        state.messages.push({ type: 'greeting', text: config.greeting });
      }
      state.messages.push(...history);
    } else if (config.greeting) {
      state.messages.push({ type: 'greeting', text: config.greeting });
    }

    render();
  }

  // ─── Public API ───────────────────────────────────────────────────

  function init(opts) {
    config = { ...DEFAULTS, ...opts };
    if (!config.api) {
      console.error('[ConduitChat] Missing required "api" option (e.g., "https://your-conduit/api/v1")');
      return;
    }
    if (!config.key) {
      console.error('[ConduitChat] Missing required "key" option (API key)');
      return;
    }
    mount();
  }

  function destroy() {
    if (root) {
      root.remove();
      root = null;
    }
    const style = document.getElementById('conduit-chat-styles');
    if (style) style.remove();
    state = { open: false, messages: [], loading: false };
  }

  function open() { state.open = true; render(); }
  function close() { state.open = false; render(); }
  function toggle() { state.open = !state.open; render(); }

  function ask(query) {
    if (!state.open) { state.open = true; render(); }
    sendMessage(query);
  }

  function clearHistory() {
    state.messages = [];
    if (config.greeting) {
      state.messages.push({ type: 'greeting', text: config.greeting });
    }
    if (config.persist) {
      try {
        localStorage.removeItem('conduit-chat-' + (config.persistKey || 'default'));
      } catch (_) {}
    }
    render();
  }

  // Expose global API
  window.ConduitChat = { init, destroy, open, close, toggle, ask, clearHistory };

  // ─── Auto-init from script tag ────────────────────────────────────

  function autoInit() {
    const script = document.currentScript
      || document.querySelector('script[data-api][src*="conduit-chat"]');
    if (!script) return;

    const api = script.getAttribute('data-api');
    const key = script.getAttribute('data-key');
    if (!api || !key) return;

    const suggestionsAttr = script.getAttribute('data-suggestions');
    init({
      api,
      key,
      title: script.getAttribute('data-title') || DEFAULTS.title,
      subtitle: script.getAttribute('data-subtitle') || DEFAULTS.subtitle,
      placeholder: script.getAttribute('data-placeholder') || DEFAULTS.placeholder,
      accent: script.getAttribute('data-accent') || DEFAULTS.accent,
      position: script.getAttribute('data-position') || DEFAULTS.position,
      mode: script.getAttribute('data-mode') || DEFAULTS.mode,
      greeting: script.getAttribute('data-greeting') || DEFAULTS.greeting,
      suggestions: suggestionsAttr ? suggestionsAttr.split('|') : DEFAULTS.suggestions,
      persist: script.getAttribute('data-persist') === 'true',
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})();
