#!/usr/bin/env node
'use strict';

// news.js — a terminal news reader for Politics and Economics.
//
// No API keys, no install step, no third-party packages. It reads public
// RSS/Atom feeds using only Node's built-in modules, then lets you drill
// from the two top-level sections down into focused sub-topics and finally
// into individual articles.
//
//   Run it with:  node news.js
//
// Optional flags (for quick, non-interactive use):
//   node news.js politics            -> dump top political headlines
//   node news.js economics markets   -> dump the Markets & Stocks sub-topic
//   node news.js --list              -> print every section/topic key

const readline = require('readline');
const { SECTIONS } = require('./feeds');
const { loadTopic } = require('./feedlib');

// ---------------------------------------------------------------------------
// Tiny terminal color helpers (skipped automatically when output isn't a TTY).
// ---------------------------------------------------------------------------
const useColor = process.stdout.isTTY;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const cyan = (s) => c('36', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function timeAgo(date) {
  if (!date) return '';
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function clearScreen() {
  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
}

function header(text) {
  console.log('');
  console.log(bold(cyan('  ' + text)));
  console.log(dim('  ' + '─'.repeat(Math.max(text.length, 30))));
}

function printHeadlines(topic, loaded) {
  header(topic.title);
  if (loaded.items.length === 0) {
    console.log(yellow('\n  No headlines found right now.'));
    if (loaded.okFeeds === 0) {
      console.log(dim('  (Could not reach any news feed — check your internet connection.)'));
    } else if (topic.keywords) {
      console.log(dim('  (Feeds loaded, but nothing matched this sub-topic at the moment.)'));
    }
    console.log('');
    return;
  }
  console.log('');
  loaded.items.forEach((it, i) => {
    const num = green(String(i + 1).padStart(2, ' '));
    const when = it.date ? dim(`  (${timeAgo(it.date)})`) : '';
    console.log(`  ${num}. ${it.title}${when}`);
  });
  if (loaded.okFeeds < loaded.totalFeeds) {
    console.log(dim(`\n  (${loaded.okFeeds}/${loaded.totalFeeds} sources reachable)`));
  }
  console.log('');
}

function printArticle(item) {
  header(item.title);
  console.log('');
  if (item.date) console.log(dim('  ' + item.date.toLocaleString()));
  if (item.summary) {
    console.log('');
    // Wrap the summary at ~76 columns.
    const words = item.summary.split(' ');
    let line = '  ';
    for (const w of words) {
      if ((line + w).length > 76) {
        console.log(line);
        line = '  ';
      }
      line += w + ' ';
    }
    if (line.trim()) console.log(line);
  }
  if (item.link) {
    console.log('');
    console.log('  ' + bold('Link: ') + cyan(item.link));
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Interactive menu
// ---------------------------------------------------------------------------

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

async function articleMenu(rl, loaded, topic) {
  for (;;) {
    const ans = await ask(
      rl,
      bold('\n  Enter a number to read it, [b] back, [r] refresh, [q] quit: ')
    );
    const lower = ans.toLowerCase();
    if (lower === 'q') return 'quit';
    if (lower === 'b' || lower === '') return 'back';
    if (lower === 'r') return 'refresh';
    const n = parseInt(ans, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= loaded.items.length) {
      clearScreen();
      printArticle(loaded.items[n - 1]);
    } else {
      console.log(yellow('  Not a valid choice.'));
    }
  }
}

async function topicLoop(rl, topic) {
  for (;;) {
    clearScreen();
    console.log(dim('\n  Loading ' + topic.title + '…'));
    let loaded;
    try {
      loaded = await loadTopic(topic);
    } catch (err) {
      loaded = { items: [], okFeeds: 0, totalFeeds: topic.feeds.length };
    }
    clearScreen();
    printHeadlines(topic, loaded);
    const action = await articleMenu(rl, loaded, topic);
    if (action === 'quit') return 'quit';
    if (action === 'back') return 'back';
    // 'refresh' falls through and reloads.
  }
}

async function sectionMenu(rl, section) {
  const keys = Object.keys(section.children);
  for (;;) {
    clearScreen();
    header(section.title);
    console.log('');
    keys.forEach((k, i) => {
      console.log(`  ${green(String(i + 1))}. ${section.children[k].title}`);
    });
    console.log(dim('\n  [b] back to main menu   [q] quit'));
    const ans = (await ask(rl, bold('\n  Choose a topic: '))).toLowerCase();
    if (ans === 'q') return 'quit';
    if (ans === 'b' || ans === '') return 'back';
    const n = parseInt(ans, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= keys.length) {
      const result = await topicLoop(rl, section.children[keys[n - 1]]);
      if (result === 'quit') return 'quit';
    }
  }
}

async function mainMenu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const sectionKeys = Object.keys(SECTIONS);
  for (;;) {
    clearScreen();
    console.log('');
    console.log(bold(cyan('  ╔════════════════════════════════════════╗')));
    console.log(bold(cyan('  ║          NEWS  READER                  ║')));
    console.log(bold(cyan('  ║     Politics  ·  Economics             ║')));
    console.log(bold(cyan('  ╚════════════════════════════════════════╝')));
    console.log('');
    sectionKeys.forEach((k, i) => {
      console.log(`  ${green(String(i + 1))}. ${SECTIONS[k].title}`);
    });
    console.log(dim('\n  [q] quit'));
    const ans = (await ask(rl, bold('\n  Choose a section: '))).toLowerCase();
    if (ans === 'q' || ans === 'quit') break;
    const n = parseInt(ans, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= sectionKeys.length) {
      const result = await sectionMenu(rl, SECTIONS[sectionKeys[n - 1]]);
      if (result === 'quit') break;
    }
  }
  rl.close();
  console.log(dim('\n  Bye.\n'));
}

// ---------------------------------------------------------------------------
// Non-interactive (CLI argument) mode
// ---------------------------------------------------------------------------

function listKeys() {
  console.log('\nAvailable sections and topics:\n');
  for (const [sk, section] of Object.entries(SECTIONS)) {
    console.log(`  ${sk}`);
    for (const [tk, topic] of Object.entries(section.children)) {
      console.log(`     ${sk} ${tk}    ${dim('— ' + topic.title)}`);
    }
  }
  console.log('');
}

async function runOnce(sectionKey, topicKey) {
  const section = SECTIONS[sectionKey];
  if (!section) {
    console.error(`Unknown section "${sectionKey}". Try --list.`);
    process.exitCode = 1;
    return;
  }
  const topic = topicKey ? section.children[topicKey] : section.children.top;
  if (!topic) {
    console.error(`Unknown topic "${topicKey}" in ${sectionKey}. Try --list.`);
    process.exitCode = 1;
    return;
  }
  console.log(dim('Loading ' + topic.title + '…'));
  const loaded = await loadTopic(topic);
  printHeadlines(topic, loaded);
  loaded.items.forEach((it) => {
    if (it.link) console.log(dim('     ' + it.link));
  });
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
News Reader — Politics & Economics in your terminal.

  node news.js                     interactive menu
  node news.js <section> [topic]   print a topic and exit
  node news.js --list              show all section/topic keys
  node news.js --help              this message
`);
    return;
  }
  if (args.includes('--list')) {
    listKeys();
    return;
  }
  if (args.length >= 1) {
    await runOnce(args[0], args[1]);
    return;
  }
  await mainMenu();
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exitCode = 1;
});
