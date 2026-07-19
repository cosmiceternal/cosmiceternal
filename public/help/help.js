/* Get Help page. Region-aware lifeline + resource directory, plus a gentle
   self-check. Self-contained; mirrors the helpline data used in the app modal. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Primary lifeline shown in the hero, per region.
  const LIFELINE = {
    us:   { label: 'National Problem Gambling Helpline', number: '1-800-GAMBLER', tel: '1-800-426-2537', note: 'Call or text · free & confidential · 24/7' },
    uk:   { label: 'National Gambling Helpline (GamCare)', number: '0808 8020 133', tel: '08088020133', note: 'Free · confidential · 24/7' },
    ca:   { label: 'ConnexOntario', number: '1-866-531-2600', tel: '18665312600', note: 'Free · confidential · 24/7 (Ontario)' },
    au:   { label: 'Gambling Help Online', number: '1800 858 858', tel: '1800858858', note: 'Free · confidential · 24/7' },
    intl: { label: 'Find a helpline near you', number: 'International directory', tel: '', note: 'Free, confidential support exists in most countries' }
  };

  // Full resource lists per region (mirrors public/js/help.js).
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

  function renderRegion(r) {
    const L = LIFELINE[r] || LIFELINE.us;
    $('lifelineNumber').textContent = L.number;
    $('lifelineNumber').setAttribute('href', L.tel ? 'tel:' + L.tel : 'https://www.begambleaware.org/');
    document.querySelector('.lifeline-label').textContent = L.label;
    $('lifelineNote').textContent = L.note;
    const list = RESOURCES[r] || [];
    $('resources').innerHTML = list.map(x => `
      <a class="resource" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">
        <span class="res-name">${esc(x.name)}</span>
        <span class="res-contact">${esc(x.contact)}</span>
        ${x.note ? `<span class="res-note">${esc(x.note)}</span>` : ''}
      </a>`).join('');
    $('regionSel').value = r;
  }

  function guessRegion() {
    try {
      const loc = (navigator.language || 'en-US').toLowerCase();
      if (loc.includes('gb')) return 'uk';
      if (loc.endsWith('-ca')) return 'ca';
      if (loc.endsWith('-au')) return 'au';
      if (loc.endsWith('-us')) return 'us';
    } catch (_) {}
    return 'us';
  }

  function updateCheck() {
    const boxes = $('checklist').querySelectorAll('input[type="checkbox"]');
    const n = Array.from(boxes).filter(b => b.checked).length;
    const el = $('checkResult');
    if (n === 0) { el.hidden = true; return; }
    el.hidden = false;
    if (n <= 1) {
      el.className = 'check-result low';
      el.textContent = 'Good to check in. Keep an eye on it — and remember the limit tools below are there whenever you want them.';
    } else if (n <= 3) {
      el.className = 'check-result some';
      el.textContent = 'A few of these ring true. It might be a good moment to set a daily loss limit or take a short break. No judgment — lots of people do.';
    } else {
      el.className = 'check-result high';
      el.textContent = 'This sounds like it’s weighing on you. Please consider talking to one of the free, confidential lines above — reaching out really does help.';
    }
  }

  const start = guessRegion();
  renderRegion(start);
  $('regionSel').addEventListener('change', (e) => renderRegion(e.target.value));
  $('checklist').addEventListener('change', updateCheck);
})();
