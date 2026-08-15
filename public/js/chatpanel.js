/* Always-on chat sidebar.
 *
 * Chat used to be a tab inside the bets feed, so it was invisible unless you
 * went looking. It now owns its own column and polls continuously, which is
 * what makes a casino floor feel populated. Kept independent of feed.js so the
 * two never fight over one list element.
 *
 * Every message is rendered with textContent — chat text never becomes HTML. */
(function (global) {
  'use strict';

  const POLL_MS = 5000;
  let listEl, inputEl, sendEl, onlineEl;
  let msgs = [], lastId = 0, timer = null, alive = false;

  // Set once the app knows who is signed in, so a player can pick their own
  // lines out of the stream at a glance.
  let me = '';
  function setUser(name) { me = String(name || ''); }

  function rowEl(m) {
    const li = document.createElement('li');
    li.className = 'cs-row' + (me && m.user === me ? ' is-me' : '');
    const who = document.createElement('span');
    who.className = 'cs-who';
    who.textContent = m.user;
    // Click another player's name to open a private message thread with them.
    if (global.Messages && m.user && m.user !== me) {
      who.classList.add('cs-dm');
      who.title = 'Message ' + m.user;
      who.addEventListener('click', () => Messages.openThread(m.user));
    }
    const lvl = document.createElement('span');
    lvl.className = 'cs-lvl';
    lvl.textContent = 'L' + m.level;
    const text = document.createElement('span');
    text.className = 'cs-text';
    text.textContent = m.text;
    li.append(who, lvl, text);
    return li;
  }

  function render() {
    if (!listEl) return;
    // Only auto-scroll if the reader is already at the bottom — otherwise a new
    // message would yank them away from what they were reading.
    const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
    listEl.innerHTML = '';
    if (!msgs.length) {
      const li = document.createElement('li');
      li.className = 'cs-empty';
      li.textContent = 'No messages yet — say hi!';
      listEl.appendChild(li);
      return;
    }
    msgs.slice(-80).forEach(m => listEl.appendChild(rowEl(m)));
    if (atBottom) listEl.scrollTop = listEl.scrollHeight;
  }

  function setOnline(n) {
    if (onlineEl && typeof n === 'number') onlineEl.textContent = n.toLocaleString();
  }

  async function load() {
    try {
      const r = await API.chatList(lastId);
      if (r.messages && r.messages.length) {
        msgs.push(...r.messages);
        lastId = r.messages[r.messages.length - 1].id;
        if (msgs.length > 200) msgs = msgs.slice(-120);
        render();
      } else if (!msgs.length) render();
      setOnline(r.online);
    } catch (e) { if (!msgs.length) render(); }
  }

  async function send() {
    const text = (inputEl.value || '').trim();
    if (!text) return;
    inputEl.value = '';
    try {
      await API.chatSend(text);
      await load();
    } catch (e) {
      Toast.warn(e.message);
      inputEl.value = text; // give the message back rather than losing it
    }
  }

  function start() {
    if (alive) return;
    alive = true;
    load();
    timer = setInterval(load, POLL_MS);
  }
  function stop() { alive = false; if (timer) { clearInterval(timer); timer = null; } }

  function init() {
    listEl = document.getElementById('csList');
    inputEl = document.getElementById('csInput');
    sendEl = document.getElementById('csSend');
    onlineEl = document.getElementById('csOnline');
    if (!listEl) return;
    if (sendEl) sendEl.addEventListener('click', send);
    if (inputEl) inputEl.addEventListener('keydown', (e) => {
      // Enter sends; the handler stops here so the global game hotkey in app.js
      // can't also fire a bet while you're typing.
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); send(); }
    });
    const toggle = document.getElementById('csToggle');
    // The collapsed state keeps a narrow rail so this button stays reachable —
    // hiding the whole panel would hide its own re-open control.
    const syncToggle = () => {
      const collapsed = document.body.classList.contains('chat-collapsed');
      if (toggle) {
        toggle.textContent = collapsed ? '\u203a' : '\u2039';
        toggle.title = collapsed ? 'Show chat' : 'Hide chat';
      }
    };
    if (toggle) toggle.addEventListener('click', () => {
      document.body.classList.toggle('chat-collapsed');
      try { localStorage.setItem('crypt.chatCollapsed', document.body.classList.contains('chat-collapsed') ? '1' : '0'); } catch (_) {}
      syncToggle();
    });
    try { if (localStorage.getItem('crypt.chatCollapsed') === '1') document.body.classList.add('chat-collapsed'); } catch (_) {}
    syncToggle();
    start();
  }

  global.ChatPanel = { init, start, stop, load, setUser };
})(window);
