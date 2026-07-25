/* Mounts and plays every game in a real browser.
 *
 * Browser smoke test — NOT part of `npm test` (needs Playwright, which is not
 * a project dependency). Run manually against a locally running server:
 *
 *   PORT=4640 DB_PATH=/tmp/smoke.db node server/index.js &
 *   node scripts/ui-smoke.js
 *
 * Exits non-zero if anything fails. The API-level equivalent that DOES run in
 * CI is test/all-games.test.js.
 */
// Mount and play EVERY game in the real UI, collecting console errors per game.
(async () => {
  const pw = require('/opt/node22/lib/node_modules/playwright');
  const b = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(()=>pw.chromium.launch());
  const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } });
  const p = await ctx.newPage();
  let current = 'boot';
  const errs = [];
  p.on('console', m => { if (m.type()==='error') errs.push([current, 'CONSOLE ' + m.text().slice(0,160)]); });
  p.on('pageerror', e => errs.push([current, 'PAGEERROR ' + String(e.message).slice(0,160)]));

  await p.goto('http://localhost:4640/', { waitUntil: 'networkidle' });
  await p.evaluate(() => { try { localStorage.setItem('crypt.onboarded','1'); } catch(e){} });
  await p.fill('#authUser','ui'+(Date.now()%1000000));
  await p.fill('#authPass','Trombone7Willow2Cliff');
  await p.click('[data-auth="register"]'); await p.click('#authSubmit');
  await p.waitForTimeout(1600);
  await p.evaluate(() => ['tourOverlay','dailyModal'].forEach(id => { const e=document.getElementById(id); if(e) e.remove(); }));

  // Every real game key from the catalog (exclude category filters).
  const games = await p.evaluate(() => (window.GameCatalog && GameCatalog.GAMES ? GameCatalog.GAMES : []).map(g => g.key));
  console.log('games discovered in catalog:', games.length);

  const results = [];
  for (const key of games) {
    current = key;
    const before = errs.length;
    await p.evaluate(k => window.CryptNav && CryptNav.select(k), key);
    await p.waitForTimeout(600);
    await p.evaluate(() => { const d=document.getElementById('dailyModal'); if(d) d.remove(); });
    // did it render controls?
    const mounted = await p.evaluate(() => {
      const pane = document.getElementById('gamePane');
      return !!pane && pane.querySelectorAll('button, input').length > 0;
    });
    // click its primary action
    let clicked = false;
    const btn = await p.$('#gamePane .btn-primary:not([disabled])');
    if (btn) { try { await btn.click({ timeout: 3000 }); clicked = true; } catch(_){} }
    await p.waitForTimeout(900);
    results.push({ key, mounted, clicked, newErrors: errs.length - before });
  }
  await b.close();

  const bad = results.filter(r => !r.mounted || r.newErrors > 0);
  console.log('\n===== UI RESULTS =====');
  console.log('games checked : ' + results.length);
  console.log('mounted OK    : ' + results.filter(r=>r.mounted).length);
  console.log('primary clicked: ' + results.filter(r=>r.clicked).length);
  console.log('total console errors: ' + errs.length);
  const unclicked = results.filter(r=>!r.clicked);
  if (unclicked.length) { console.log('\n--- NO PRIMARY BUTTON CLICKED ---'); unclicked.forEach(r=>console.log('  ? '+r.key)); }
  if (bad.length) {
    console.log('\n--- PROBLEM GAMES ---');
    bad.forEach(r => console.log(`  ✗ ${r.key}: mounted=${r.mounted} clicked=${r.clicked} errors=${r.newErrors}`));
  }
  if (errs.length) {
    console.log('\n--- ERROR DETAIL (first 15) ---');
    errs.slice(0,15).forEach(([g,e]) => console.log(`  [${g}] ${e}`));
  }
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('UI HARNESS ERROR', e.message); process.exit(2); });
