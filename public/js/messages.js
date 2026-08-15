/* Direct messages — private 1-on-1 mail, as a modal inbox.
 *
 * The lobby chat sidebar (chatpanel.js) is the public room; this is private
 * threads. Same poll-based model (no websockets in this stack) and the same
 * hard rule: every message is rendered with textContent, so message text never
 * becomes HTML.
 *
 * Two polls run:
 *   - a cheap unread-count poll that keeps the header badge live whether or not
 *     the modal is open;
 *   - a per-thread poll (only while a thread is open) that streams new lines and
 *     marks them read.
 */
(function (global) {
  'use strict';

  const UNREAD_POLL_MS = 12000;
  const THREAD_POLL_MS = 5000;

  let modal, badge, convosEl, inboxView, threadView, msgsEl, inputEl, sendEl,
      backEl, partnerEl, newUserEl, newGoEl, titleEl;
  let me = '';
  let current = '';                 // username of the open thread, '' when in inbox
  let msgs = [], lastId = 0;
  let threadTimer = null, unreadTimer = null, wired = false;

  function setUser(name) { me = String(name || ''); }

  // ---- time ----
  function ago(ts) {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 45) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    const d = Math.floor(h / 24);
    if (d < 7) return d + 'd';
    return new Date(ts).toLocaleDateString();
  }

  // ---- badge ----
  function setBadge(n) {
    if (!badge) return;
    n = Number(n) || 0;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hidden', n <= 0);
  }
  async function pollUnread() {
    try { const r = await API.dmUnread(); setBadge(r.unread); } catch (_) {}
  }

  // ---- inbox ----
  function convoRow(c) {
    const li = document.createElement('li');
    li.className = 'dm-convo' + (c.unread > 0 ? ' has-unread' : '');
    li.tabIndex = 0;

    const top = document.createElement('div');
    top.className = 'dm-convo-top';
    const who = document.createElement('span');
    who.className = 'dm-convo-who';
    who.textContent = c.user;
    const when = document.createElement('span');
    when.className = 'dm-convo-when';
    when.textContent = ago(c.ts);
    top.append(who, when);

    const prev = document.createElement('div');
    prev.className = 'dm-convo-prev';
    const preview = (c.lastMine ? 'You: ' : '') + c.last;
    prev.textContent = preview;

    li.append(top, prev);
    if (c.unread > 0) {
      const pill = document.createElement('span');
      pill.className = 'dm-unread-pill';
      pill.textContent = c.unread > 9 ? '9+' : String(c.unread);
      li.appendChild(pill);
    }
    const open = () => openThread(c.user);
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    return li;
  }

  async function loadInbox() {
    if (!convosEl) return;
    try {
      const r = await API.dmList();
      setBadge(r.unread);
      convosEl.innerHTML = '';
      if (!r.conversations || !r.conversations.length) {
        const li = document.createElement('li');
        li.className = 'dm-empty';
        li.textContent = 'No conversations yet — start one above.';
        convosEl.appendChild(li);
        return;
      }
      r.conversations.forEach(c => convosEl.appendChild(convoRow(c)));
    } catch (e) {
      if (global.Toast) Toast.warn(e.message);
    }
  }

  // ---- thread ----
  function msgRow(m) {
    const li = document.createElement('li');
    li.className = 'dm-msg' + (m.mine ? ' mine' : '');
    const bubble = document.createElement('div');
    bubble.className = 'dm-bubble';
    const text = document.createElement('span');
    text.className = 'dm-msg-text';
    text.textContent = m.text;
    const meta = document.createElement('span');
    meta.className = 'dm-msg-time';
    meta.textContent = ago(m.ts);
    bubble.append(text, meta);
    li.appendChild(bubble);
    return li;
  }

  function renderThread() {
    if (!msgsEl) return;
    const atBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 60;
    msgsEl.innerHTML = '';
    if (!msgs.length) {
      const li = document.createElement('li');
      li.className = 'dm-empty';
      li.textContent = 'No messages yet — say hello.';
      msgsEl.appendChild(li);
      return;
    }
    msgs.slice(-120).forEach(m => msgsEl.appendChild(msgRow(m)));
    if (atBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  async function loadThread() {
    if (!current) return;
    try {
      const r = await API.dmThread(current, lastId);
      if (r.partner && partnerEl) {
        partnerEl.textContent = r.partner.user;
        current = r.partner.user; // canonical casing from the server
      }
      if (r.messages && r.messages.length) {
        msgs.push(...r.messages);
        lastId = r.messages[r.messages.length - 1].id;
        if (msgs.length > 300) msgs = msgs.slice(-160);
        renderThread();
        // Anything they just sent me is now on screen — mark the thread read.
        if (r.messages.some(m => !m.mine)) {
          try { await API.dmRead(current); } catch (_) {}
          pollUnread();
        }
      } else if (!msgs.length) {
        renderThread();
      }
    } catch (e) {
      // A bad recipient (e.g. typo in "new message") lands here — show it in the
      // thread area rather than a toast, and don't keep polling a dead thread.
      stopThreadPoll();
      if (msgsEl) {
        msgsEl.innerHTML = '';
        const li = document.createElement('li');
        li.className = 'dm-empty';
        li.textContent = e.message || 'Could not open that conversation.';
        msgsEl.appendChild(li);
      }
    }
  }

  async function sendMsg() {
    if (!current || !inputEl) return;
    const text = (inputEl.value || '').trim();
    if (!text) return;
    inputEl.value = '';
    try {
      await API.dmSend(current, text);
      await loadThread();
    } catch (e) {
      if (global.Toast) Toast.warn(e.message);
      inputEl.value = text; // hand the message back rather than losing it
    }
  }

  function showInbox() {
    current = '';
    stopThreadPoll();
    if (threadView) threadView.classList.add('hidden');
    if (inboxView) inboxView.classList.remove('hidden');
    if (titleEl) titleEl.textContent = '✉ Messages';
    loadInbox();
  }

  function showThread(username) {
    current = String(username || '').trim();
    if (!current) return;
    msgs = []; lastId = 0;
    if (inboxView) inboxView.classList.add('hidden');
    if (threadView) threadView.classList.remove('hidden');
    if (partnerEl) partnerEl.textContent = current;
    if (titleEl) titleEl.textContent = '✉ Messages';
    if (msgsEl) msgsEl.innerHTML = '';
    loadThread();
    startThreadPoll();
    if (inputEl) inputEl.focus();
  }

  function startThreadPoll() {
    stopThreadPoll();
    threadTimer = setInterval(loadThread, THREAD_POLL_MS);
  }
  function stopThreadPoll() {
    if (threadTimer) { clearInterval(threadTimer); threadTimer = null; }
  }

  // ---- open / close ----
  function open() {
    if (!modal) return;
    modal.classList.remove('hidden');
    showInbox();
  }
  function openThread(username) {
    if (!modal) return;
    modal.classList.remove('hidden');
    showThread(username);
  }
  function close() {
    if (!modal) return;
    modal.classList.add('hidden');
    stopThreadPoll();
    current = '';
    pollUnread();
  }
  function isOpen() { return modal && !modal.classList.contains('hidden'); }

  function startNew() {
    if (!newUserEl) return;
    const name = (newUserEl.value || '').trim();
    if (!name) { newUserEl.focus(); return; }
    if (me && name === me) { if (global.Toast) Toast.warn("You can't message yourself."); return; }
    newUserEl.value = '';
    showThread(name);
  }

  function init() {
    modal = document.getElementById('dmModal');
    badge = document.getElementById('dmBadge');
    convosEl = document.getElementById('dmConvos');
    inboxView = document.getElementById('dmInbox');
    threadView = document.getElementById('dmThread');
    msgsEl = document.getElementById('dmMsgs');
    inputEl = document.getElementById('dmInput');
    sendEl = document.getElementById('dmSend');
    backEl = document.getElementById('dmBack');
    partnerEl = document.getElementById('dmPartner');
    newUserEl = document.getElementById('dmNewUser');
    newGoEl = document.getElementById('dmNewGo');
    titleEl = document.getElementById('dmTitle');
    const btn = document.getElementById('btnMessages');
    const closeBtn = document.getElementById('dmClose');
    if (!modal || !btn) return;

    if (!wired) {
      wired = true;
      btn.addEventListener('click', open);
      if (closeBtn) closeBtn.addEventListener('click', close);
      if (backEl) backEl.addEventListener('click', showInbox);
      if (sendEl) sendEl.addEventListener('click', sendMsg);
      if (newGoEl) newGoEl.addEventListener('click', startNew);
      // Click on the backdrop (outside the dialog) closes, matching the other modals.
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
      if (inputEl) inputEl.addEventListener('keydown', (e) => {
        // Enter sends; stop here so the global game hotkey in app.js can't also
        // fire a bet while you're typing a message.
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); sendMsg(); }
      });
      if (newUserEl) newUserEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); startNew(); }
      });
    }

    setBadge(0);
    pollUnread();
    if (!unreadTimer) unreadTimer = setInterval(pollUnread, UNREAD_POLL_MS);
  }

  global.Messages = { init, setUser, open, openThread, close, isOpen };
})(window);
