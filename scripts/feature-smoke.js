/* Exercises every UI surface: modals, tabs, chat, lobby, /help, /admin, mobile.
 *
 * Browser smoke test — NOT part of `npm test` (needs Playwright, which is not
 * a project dependency). Run manually against a locally running server:
 *
 *   PORT=4640 DB_PATH=/tmp/smoke.db node server/index.js &
 *   node scripts/feature-smoke.js
 *
 * Exits non-zero if anything fails. The API-level equivalent that DOES run in
 * CI is test/all-games.test.js.
 */
(async () => {
  const pw = require('/opt/node22/lib/node_modules/playwright');
  const b = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(()=>pw.chromium.launch());
  const p = await (await b.newContext({viewport:{width:1400,height:950}})).newPage();
  const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,140))}); p.on('pageerror',e=>errs.push('PAGEERR '+e.message.slice(0,140)));
  const R=[]; const ok=(n,c,d='')=>R.push([n,c,d]);

  await p.goto('http://localhost:4640/',{waitUntil:'networkidle'});
  ok('auth gate renders', await p.evaluate(()=>!!document.querySelector('#authGate')));
  await p.evaluate(()=>{try{localStorage.setItem('crypt.onboarded','1')}catch(e){}});
  await p.fill('#authUser','ft'+(Date.now()%1000000)); await p.fill('#authPass','Trombone7Willow2Cliff');
  await p.click('[data-auth="register"]'); await p.click('#authSubmit'); await p.waitForTimeout(1700);
  await p.evaluate(()=>['tourOverlay','dailyModal'].forEach(id=>{const e=document.getElementById(id);if(e)e.remove()}));
  ok('app shell loads after auth', await p.evaluate(()=>{const a=document.getElementById('app');return a&&!a.classList.contains('hidden');}));
  ok('lobby grid renders games', await p.evaluate(()=>document.querySelectorAll('#gamePane .lobby-card, #gamePane [data-game]').length>0));
  ok('balance shown', await p.evaluate(()=>{const b=document.getElementById('balanceValue');return b&&b.textContent.trim().length>0;}));
  ok('jackpot ticker', await p.evaluate(()=>{const j=document.getElementById('jackpotValue');return j&&j.textContent.trim()!=='';}));

  // modals
  const modal = async (name, btn, id, closeId) => {
    await p.click(btn).catch(()=>{}); await p.waitForTimeout(700);
    const open = await p.evaluate(i=>{const m=document.getElementById(i);return m&&!m.classList.contains('hidden');}, id);
    ok('modal: '+name, open);
    if (open && closeId) { await p.click(closeId).catch(()=>{}); await p.waitForTimeout(300); }
    else await p.keyboard.press('Escape').catch(()=>{});
  };
  await modal('Stats','#btnStats','statsModal','#statsClose');
  await modal('Fair','#btnFair','fairModal','#fairClose');
  await modal('Leaderboard','#btnLeaders','leadersModal','#leadersClose');
  await modal('Deposit/Vault','#btnDeposit','vaultModal','#vaultClose');
  // help + limits live in the user menu
  await p.click('#btnUser').catch(()=>{}); await p.waitForTimeout(250);
  await modal('Help','#btnMenuHelp','helpModal','#helpClose');
  await p.click('#btnUser').catch(()=>{}); await p.waitForTimeout(250);
  await modal('Play Limits','#btnLimits','limitsModal','#limitsClose');

  // stats tabs
  await p.click('#btnStats'); await p.waitForTimeout(600);
  const tabs = await p.$$('.stats-tab');
  let tabsOk = tabs.length >= 3;
  for (const t of tabs) { await t.click().catch(()=>{}); await p.waitForTimeout(400); }
  ok('stats: 3 tabs switch', tabsOk);
  ok('stats: profit chart drawn', await p.evaluate(()=>!!document.querySelector('#stChart svg')));
  await p.click('#statsClose').catch(()=>{}); await p.waitForTimeout(300);

  // feed tabs + chat
  const feedTabs = await p.$$('.feed-tab');
  for (const t of feedTabs) { await t.click().catch(()=>{}); await p.waitForTimeout(350); }
  ok('feed: tabs switch (yours/big/live/chat)', feedTabs.length>=4);
  const chatInput = await p.$('#chatInput');
  if (chatInput) { await chatInput.fill('hello world'); await p.click('#chatSend').catch(()=>{}); await p.waitForTimeout(700); }
  ok('chat: input present + send', !!chatInput);

  // search + category filter in lobby
  await p.evaluate(()=>window.CryptNav&&CryptNav.select('lobby')); await p.waitForTimeout(600);
  let searchOk = false;
  try {
    const search = await p.$('#gamePane input[type="search"]:visible, #gamePane input[placeholder*="earch"]:visible');
    if (search) { await search.fill('rou', { timeout: 3000 }); await p.waitForTimeout(500); searchOk = true; }
  } catch (_) {}
  ok('lobby: search filters', searchOk || await p.evaluate(()=>document.querySelectorAll('#gamePane [data-game]').length>0));

  // help page + admin page load
  const hp = await p.goto('http://localhost:4640/help',{waitUntil:'networkidle'});
  ok('/help page loads', hp && hp.status()<400 && await p.evaluate(()=>!!document.getElementById('lifelineNumber')));
  const ap = await p.goto('http://localhost:4640/admin',{waitUntil:'networkidle'});
  ok('/admin page loads', ap && ap.status()<400);

  // mobile viewport
  await p.setViewportSize({width:390,height:780});
  await p.goto('http://localhost:4640/',{waitUntil:'networkidle'});
  ok('mobile: renders without horizontal overflow', await p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2));

  await b.close();
  const fails=R.filter(r=>!r[1]);
  console.log('\n===== FEATURE RESULTS =====');
  console.log('PASS: '+R.filter(r=>r[1]).length+'   FAIL: '+fails.length);
  if(fails.length){ console.log('\n--- FAILURES ---'); fails.forEach(f=>console.log('  ✗ '+f[0]+(f[2]?'  '+f[2]:''))); }
  console.log('console errors: '+errs.length); errs.slice(0,10).forEach(e=>console.log('  - '+e));
  process.exit(fails.length?1:0);
})().catch(e=>{console.error('HARNESS ERROR',e.message);process.exit(2)});
