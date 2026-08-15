'use strict';

/* Direct-messages (private 1-on-1 mail) integration tests.
 *
 * Spawns the real server and drives it over HTTP with cookie sessions, the same
 * way a browser would. Each sub-test registers its own fresh user pair so the
 * per-sender rate bucket and unread counters never leak between cases. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.join(__dirname, '..');
const PORT = 7100 + (process.pid % 100);
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-dm-${process.pid}.db`;

function rmDb() { for (const f of [DB, DB + '-shm', DB + '-wal']) { try { fs.unlinkSync(f); } catch (_) {} } }
function newSession() { return { csrf: '', jar: '' }; }

async function req(sess, method, p, body, opts) {
  const headers = { Cookie: sess.jar };
  if (body) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && sess.csrf && !(opts && opts.noCsrf)) headers['X-CSRF-Token'] = sess.csrf;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const s of sc) {
    const [pair] = s.split(';'); const [k, ...v] = pair.split('='); const key = k.trim(), val = v.join('=');
    if (key === 'csrf') sess.csrf = val;
    const parts = sess.jar ? sess.jar.split('; ').filter(x => !x.startsWith(key + '=')) : [];
    parts.push(`${key}=${val}`); sess.jar = parts.join('; ');
  }
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

// Register a fresh user and return their session.
async function mkUser(name) {
  const s = newSession();
  await req(s, 'GET', '/api/me');                                  // seed csrf cookie
  const r = await req(s, 'POST', '/api/auth/register', { username: name, password: 'longpassword1' });
  assert.equal(r.status, 200, `register ${name}`);
  return s;
}

const { waitForReady } = require('./helpers/server-ready');

test('direct messages', async (t) => {
  rmDb();
  const child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, SESSION_SECRET: 'dm-test', SECURE_COOKIES: '0', RATE_API_MAX: '100000', STARTING_BALANCE: '1000' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  try {
    await waitForReady(`${BASE}/healthz`, { child });

    await t.test('send delivers, sets recipient unread, leaves sender at zero', async () => {
      const alice = await mkUser('dm_alice');
      const bob = await mkUser('dm_bob');

      const sent = await req(alice, 'POST', '/api/messages/send', { to: 'dm_bob', text: 'hey bob' });
      assert.equal(sent.status, 200);
      assert.equal(sent.data.ok, true);
      assert.equal(sent.data.to, 'dm_bob');

      const bobUnread = await req(bob, 'GET', '/api/messages/unread');
      assert.equal(bobUnread.data.unread, 1, 'bob has one unread');
      const aliceUnread = await req(alice, 'GET', '/api/messages/unread');
      assert.equal(aliceUnread.data.unread, 0, 'sender has none');
    });

    await t.test('inbox lists the conversation with a preview and unread count', async () => {
      const alice = await mkUser('inbox_a');
      const bob = await mkUser('inbox_b');
      await req(alice, 'POST', '/api/messages/send', { to: 'inbox_b', text: 'first line' });

      const inbox = await req(bob, 'GET', '/api/messages');
      assert.equal(inbox.data.unread, 1);
      assert.equal(inbox.data.conversations.length, 1);
      const c = inbox.data.conversations[0];
      assert.equal(c.user, 'inbox_a');
      assert.equal(c.last, 'first line');
      assert.equal(c.lastMine, false, 'preview knows the last line was not mine');
      assert.equal(c.unread, 1);

      // Sender's inbox shows the same thread, but lastMine=true and no unread.
      const senderInbox = await req(alice, 'GET', '/api/messages');
      assert.equal(senderInbox.data.unread, 0);
      assert.equal(senderInbox.data.conversations[0].lastMine, true);
    });

    await t.test('thread returns messages in order with correct mine flags for each side', async () => {
      const alice = await mkUser('thr_a');
      const bob = await mkUser('thr_b');
      await req(alice, 'POST', '/api/messages/send', { to: 'thr_b', text: 'yo' });
      await req(bob, 'POST', '/api/messages/send', { to: 'thr_a', text: 'sup' });

      const aView = await req(alice, 'GET', '/api/messages/thread?with=thr_b');
      assert.equal(aView.data.partner.user, 'thr_b');
      assert.deepEqual(aView.data.messages.map(m => [m.text, m.mine]), [['yo', true], ['sup', false]]);

      const bView = await req(bob, 'GET', '/api/messages/thread?with=thr_a');
      assert.deepEqual(bView.data.messages.map(m => [m.text, m.mine]), [['yo', false], ['sup', true]]);
    });

    await t.test('reading a thread clears its unread', async () => {
      const alice = await mkUser('rd_a');
      const bob = await mkUser('rd_b');
      await req(alice, 'POST', '/api/messages/send', { to: 'rd_b', text: 'ping' });
      await req(alice, 'POST', '/api/messages/send', { to: 'rd_b', text: 'ping2' });

      let unread = await req(bob, 'GET', '/api/messages/unread');
      assert.equal(unread.data.unread, 2);

      const read = await req(bob, 'POST', '/api/messages/read', { with: 'rd_a' });
      assert.equal(read.status, 200);
      assert.equal(read.data.marked, 2);

      unread = await req(bob, 'GET', '/api/messages/unread');
      assert.equal(unread.data.unread, 0);

      // The thread now reports those messages as read.
      const view = await req(bob, 'GET', '/api/messages/thread?with=rd_a');
      assert.ok(view.data.messages.every(m => m.read === true));
    });

    await t.test('since= only returns newer messages (incremental polling)', async () => {
      const alice = await mkUser('inc_a');
      const bob = await mkUser('inc_b');
      await req(alice, 'POST', '/api/messages/send', { to: 'inc_b', text: 'm1' });

      const first = await req(bob, 'GET', '/api/messages/thread?with=inc_a');
      const lastId = first.data.messages[first.data.messages.length - 1].id;

      const none = await req(bob, 'GET', '/api/messages/thread?with=inc_a&since=' + lastId);
      assert.equal(none.data.messages.length, 0, 'nothing newer than the last id');

      await req(alice, 'POST', '/api/messages/send', { to: 'inc_b', text: 'm2' });
      const delta = await req(bob, 'GET', '/api/messages/thread?with=inc_a&since=' + lastId);
      assert.equal(delta.data.messages.length, 1);
      assert.equal(delta.data.messages[0].text, 'm2');
    });

    await t.test('validation: self, unknown recipient, empty, and over-length are rejected', async () => {
      const alice = await mkUser('val_a');
      await mkUser('val_b');

      const self = await req(alice, 'POST', '/api/messages/send', { to: 'val_a', text: 'me' });
      assert.equal(self.status, 400, 'no messaging yourself');

      const ghost = await req(alice, 'POST', '/api/messages/send', { to: 'nobody_here', text: 'hi' });
      assert.equal(ghost.status, 404, 'unknown recipient');

      const empty = await req(alice, 'POST', '/api/messages/send', { to: 'val_b', text: '   ' });
      assert.equal(empty.status, 400, 'empty message');

      const tooLong = await req(alice, 'POST', '/api/messages/send', { to: 'val_b', text: 'x'.repeat(501) });
      assert.equal(tooLong.status, 400, 'over the length cap');
    });

    await t.test('per-sender rate limit engages under a burst', async () => {
      const spammer = await mkUser('rate_from');
      await mkUser('rate_to');
      let limited = 0, ok = 0;
      for (let i = 0; i < 12; i++) {
        const r = await req(spammer, 'POST', '/api/messages/send', { to: 'rate_to', text: 'spam ' + i });
        if (r.status === 200) ok++;
        else if (r.status === 429) limited++;
      }
      assert.ok(ok >= 1, 'some go through');
      assert.ok(limited >= 1, 'the burst is throttled');
    });

    await t.test('auth and CSRF are enforced', async () => {
      const anon = newSession();
      await req(anon, 'GET', '/api/me'); // csrf only, not signed in
      const guarded = await req(anon, 'GET', '/api/messages');
      assert.equal(guarded.status, 401, 'must be signed in to read messages');
      const guardedSend = await req(anon, 'POST', '/api/messages/send', { to: 'anyone', text: 'hi' });
      assert.equal(guardedSend.status, 401, 'must be signed in to send');

      const csrf = await mkUser('csrf_a');
      await mkUser('csrf_b');
      const noToken = await req(csrf, 'POST', '/api/messages/send', { to: 'csrf_b', text: 'hi' }, { noCsrf: true });
      assert.equal(noToken.status, 403, 'state-changing send needs the CSRF token');
    });
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});
