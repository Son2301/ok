/**
 * Embeddable web chat widget (vanilla JS, no dependencies, ~4 KB).
 *
 *   <script src="https://agents.example.com/widget.js" data-token="pub_…" async></script>
 *
 * Talks to `GET/POST /public/chat/:token` on the origin it was loaded from.
 * All untrusted text is rendered with textContent (never innerHTML).
 */
export const WIDGET_JS = `(function () {
  var script = document.currentScript;
  if (!script || !script.dataset.token) return;
  var token = script.dataset.token;
  var base = new URL(script.src).origin;
  var endpoint = base + '/public/chat/' + encodeURIComponent(token);
  var sessionKey = 'ok-agents-session-' + token;
  var sessionId;
  try { sessionId = localStorage.getItem(sessionKey); } catch (e) {}
  if (!sessionId) {
    var bytes = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    sessionId = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    try { localStorage.setItem(sessionKey, sessionId); } catch (e) {}
  }

  var color = '#0f766e';
  var root = document.createElement('div');
  root.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
  var panel = document.createElement('div');
  panel.style.cssText = 'display:none;flex-direction:column;width:min(360px,calc(100vw - 32px));height:min(520px,calc(100vh - 96px));background:#fff;color:#111;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.18);overflow:hidden;margin-bottom:12px';
  var header = document.createElement('div');
  header.style.cssText = 'padding:12px 14px;color:#fff;font-weight:600';
  header.textContent = 'Chat';
  var log = document.createElement('div');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.style.cssText = 'flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f7f7f8';
  var form = document.createElement('form');
  form.style.cssText = 'display:flex;gap:8px;padding:10px;border-top:1px solid #e5e5e5';
  var input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 2000;
  input.placeholder = 'Nhập tin nhắn…';
  input.setAttribute('aria-label', 'Message');
  input.style.cssText = 'flex:1;padding:9px 10px;border:1px solid #d4d4d8;border-radius:8px;font:inherit;min-width:0';
  var send = document.createElement('button');
  send.type = 'submit';
  send.textContent = 'Gửi';
  send.style.cssText = 'padding:9px 14px;border:0;border-radius:8px;color:#fff;font:inherit;cursor:pointer';
  var toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Open chat');
  toggle.textContent = 'Chat';
  toggle.style.cssText = 'float:right;padding:12px 18px;border:0;border-radius:999px;color:#fff;font:inherit;font-weight:600;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.2)';

  function paint() { header.style.background = color; send.style.background = color; toggle.style.background = color; }
  function bubble(text, mine, note) {
    var b = document.createElement('div');
    b.textContent = text;
    b.style.cssText = 'max-width:85%;padding:8px 11px;border-radius:10px;white-space:pre-wrap;word-wrap:break-word;' +
      (note ? 'align-self:center;background:transparent;color:#666;font-size:12px;text-align:center' :
       mine ? 'align-self:flex-end;color:#fff;background:' + color : 'align-self:flex-start;background:#fff;border:1px solid #e5e5e5');
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  form.appendChild(input); form.appendChild(send);
  panel.appendChild(header); panel.appendChild(log); panel.appendChild(form);
  root.appendChild(panel); root.appendChild(toggle);
  paint();

  var loaded = false;
  toggle.addEventListener('click', function () {
    var open = panel.style.display !== 'flex';
    panel.style.display = open ? 'flex' : 'none';
    toggle.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
    if (open) input.focus();
    if (open && !loaded) {
      loaded = true;
      fetch(endpoint).then(function (r) { return r.ok ? r.json() : null; }).then(function (cfg) {
        if (!cfg) return;
        if (cfg.color) { color = cfg.color; paint(); }
        header.textContent = cfg.title || cfg.agentName || 'Chat';
        if (cfg.greeting) bubble(cfg.greeting, false);
      }).catch(function () {});
    }
  });

  var busy = false;
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;
    busy = true; send.disabled = true;
    input.value = '';
    bubble(text, true);
    var pending = bubble('…', false);
    fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text, sessionId: sessionId }) })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (res) {
        log.removeChild(pending);
        if (!res.ok) { bubble((res.body && res.body.error && res.body.error.message) || 'Error', false, true); return; }
        if (res.body.disclosure) bubble(res.body.disclosure, false, true);
        bubble(res.body.reply, false);
      })
      .catch(function () { pending.textContent = 'Network error'; })
      .then(function () { busy = false; send.disabled = false; });
  });

  if (document.body) document.body.appendChild(root);
  else document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(root); });
})();
`;
