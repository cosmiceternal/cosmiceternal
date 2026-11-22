'use strict';

// The password policy is the first line of account security. Beyond length, a
// common-password blocklist, and the no-username rule, it rejects the
// low-entropy shapes a fixed blocklist can't enumerate: passwords built from
// one or two repeated characters, and long ascending/descending sequences.

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../server/auth');

const status = (pw, user) => {
  try { auth.validatePasswordPolicy(pw, user); return 0; }
  catch (e) { return e.status || -1; }
};

test('accepts reasonable passwords', () => {
  for (const pw of ['longpassword1', 'correcthorse9', 'Trombone7Willow', 'sunset-Grove42', 'my$ecretWalrus']) {
    assert.equal(status(pw), 0, `should accept ${pw}`);
  }
});

test('rejects too-short passwords', () => {
  for (const pw of ['', 'a', 'short1', 'seven77']) {
    assert.equal(status(pw), 400, `should reject ${pw}`);
  }
});

test('rejects common blocklisted passwords', () => {
  for (const pw of ['password', 'password123', '12345678', 'qwerty12', 'iloveyou']) {
    assert.equal(status(pw), 400, `should reject ${pw}`);
  }
});

test('rejects passwords containing the username', () => {
  assert.equal(status('carol12345', 'carol'), 400);
  assert.equal(status('xCAROLyzqp', 'carol'), 400, 'case-insensitive');
});

test('rejects one/two-character repetition (too few distinct chars)', () => {
  for (const pw of ['aaaaaaaa', 'abababab', 'aabbccdd', 'pwdpwdpwd1', '1111zzzz']) {
    assert.equal(status(pw), 400, `should reject low-distinct ${pw}`);
  }
  // Five distinct characters is enough to clear this particular rule.
  assert.equal(status('abcde-fff'), 0, 'five distinct chars passes the distinct rule');
});

test('rejects long ascending/descending sequences', () => {
  for (const pw of ['abcdefgh', '12345678', 'hgfedcba', 'qzabcdefg', 'zyxwvuts']) {
    assert.equal(status(pw), 400, `should reject sequence ${pw}`);
  }
  // A short run (<6) inside an otherwise varied password is fine.
  assert.equal(status('tiger123Z'), 0, 'a 3-digit run does not trip the sequence rule');
});
