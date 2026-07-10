/* Responsible gaming & help. Region-aware helpline directory rendered into
 * the Help modal, plus a shortcut to the Play Limits tools. Edit RESOURCES to
 * adjust wording or add regions — nothing else needs to change. */
(function (global) {
  'use strict';

  // Each region: a list of { name, contact, url, note? }. These are the
  // widely-published national problem-gambling helplines. Update freely.
  const RESOURCES = {
    us: [
      { name: 'National Problem Gambling Helpline', contact: 'Call or text 1-800-GAMBLER', url: 'https://www.ncpgambling.org/', note: '24/7, free & confidential (US)' },
      { name: 'Gamblers Anonymous', contact: 'Find a meeting', url: 'https://www.gamblersanonymous.org/' }
    ],
    uk: [
      { name: 'National Gambling Helpline', contact: 'Call 0808 8020 133', url: 'https://www.gamcare.org.uk/', note: 'GamCare — 24/7, free (UK)' },
      { name: 'BeGambleAware', contact: 'Advice & self-help', url: 'https://www.begambleaware.org/' },
      { name: 'GAMSTOP', contact: 'Free self-exclusion', url: 'https://www.gamstop.co.uk/' }
    ],
    ca: [
      { name: 'Canada Safer Gambling', contact: 'Provincial help lines', url: 'https://www.problemgambling.ca/' },
      { name: 'ConnexOntario', contact: 'Call 1-866-531-2600', url: 'https://www.connexontario.ca/', note: 'Ontario — 24/7' }
    ],
    au: [
      { name: 'Gambling Help Online', contact: 'Call 1800 858 858', url: 'https://www.gamblinghelponline.org.au/', note: '24/7, free (Australia)' }
    ],
    intl: [
      { name: 'Find help near you', contact: 'International directory', url: 'https://www.begambleaware.org/', note: 'If your country isn’t listed, search “problem gambling helpline” + your country, or contact a local health service.' }
    ]
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let modal, region = 'us';

  function renderRegion(r) {
    region = r;
    document.querySelectorAll('.help-region-tab').forEach(t => t.classList.toggle('active', t.dataset.region === r));
    const list = RESOURCES[r] || [];
    $('helpResources').innerHTML = list.map(x => `
      <a class="help-resource" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">
        <span class="help-res-name">${esc(x.name)}</span>
        <span class="help-res-contact">${esc(x.contact)}</span>
        ${x.note ? `<span class="help-res-note muted">${esc(x.note)}</span>` : ''}
      </a>`).join('');
  }

  function open() { modal.classList.remove('hidden'); renderRegion(region); }
  function close() { modal.classList.add('hidden'); }

  function wire() {
    modal = $('helpModal');
    if (!modal) return;
    $('btnHelp')?.addEventListener('click', open);
    $('helpClose').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    $('helpRegionTabs').addEventListener('click', (e) => {
      const t = e.target.closest('.help-region-tab');
      if (t) renderRegion(t.dataset.region);
    });
    $('helpOpenLimits').addEventListener('click', () => { close(); if (global.Limits) Limits.open(); });
    $('btnFairFooter')?.addEventListener('click', () => { const f = $('fairModal'); if (f) f.classList.remove('hidden'); });
    // Best-effort region guess from the browser locale (user can switch).
    try {
      const loc = (navigator.language || 'en-US').toLowerCase();
      if (loc.includes('gb')) region = 'uk';
      else if (loc.endsWith('-ca')) region = 'ca';
      else if (loc.endsWith('-au')) region = 'au';
      else if (loc.endsWith('-us')) region = 'us';
    } catch (_) {}
  }

  global.Help = { wire, open };
})(window);
