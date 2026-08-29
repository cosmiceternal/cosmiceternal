'use strict';

// Dashboard front end. No build step and no framework: the whole thing is a
// handful of render functions over the JSON API, which keeps the service a
// single `node bin/dealhunter.js serve` with nothing to compile.
(function () {
  const state = {
    tab: 'deals',
    lots: [],
    total: 0,
    stats: null,
    categories: [],
    sources: [],
    rules: [],
    alerts: [],
    token: localStorage.getItem('dealhunter.token') || '',
    selected: null,
    loading: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (value !== null && value !== undefined) node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  };

  // --- formatting -------------------------------------------------------
  const money = (value, currency) => {
    const n = Number(value) || 0;
    const symbol = !currency || currency === 'USD' ? '$' : `${currency} `;
    return `${n < 0 ? '-' : ''}${symbol}${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
  };
  const pct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;
  const timeLeft = (hours) => {
    if (hours === null || hours === undefined) return '—';
    if (hours <= 0) return 'closed';
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours < 48) return `${Math.round(hours)}h`;
    return `${Math.round(hours / 24)}d`;
  };
  const signClass = (value) => (value > 0 ? 'good' : value < 0 ? 'bad' : 'dim');

  // --- API --------------------------------------------------------------
  async function api(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    if (options.body) headers['content-type'] = 'application/json';
    const res = await fetch(pathname, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (res.status === 401) {
      const token = window.prompt('This dealhunter requires an API token (API_TOKEN):', state.token || '');
      if (token) {
        state.token = token;
        localStorage.setItem('dealhunter.token', token);
        return api(pathname, options);
      }
      throw new Error('unauthorized');
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    return payload;
  }

  function toast(message, isError) {
    const node = el('div', { class: `toast${isError ? ' error' : ''}`, text: message });
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 4200);
  }

  // --- filters ----------------------------------------------------------
  function currentFilters() {
    const params = {
      q: $('#f-q').value.trim(),
      category: $('#f-category').value,
      source: $('#f-source').value,
      minMargin: $('#f-margin').value,
      minProfit: $('#f-profit').value,
      closingWithin: $('#f-closing').value,
      minConfidence: $('#f-confidence').value,
      sort: $('#f-sort').value,
      limit: 200,
    };
    if (!$('#f-all').checked) params.dealsOnly = '1';
    return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== '' && value !== undefined));
  }

  // --- rendering --------------------------------------------------------
  function renderTiles() {
    const stats = state.stats;
    const root = $('#tiles');
    root.textContent = '';
    if (!stats) return;
    const scheduler = stats.scheduler || {};
    const tiles = [
      { label: 'Live lots', value: stats.live, sub: `${stats.tracked} tracked` },
      { label: 'Deals', value: stats.deals, sub: `${stats.closingSoon} closing in 24h`, good: stats.deals > 0 },
      { label: 'Profit on the table', value: money(stats.potentialProfit), sub: 'at current bids', good: stats.potentialProfit > 0 },
      { label: 'Alerts sent', value: stats.alerts, sub: `${stats.rules} rule(s)` },
      {
        label: 'Last scrape',
        value: stats.lastRun ? `${stats.lastRun.scraped}` : '—',
        sub: stats.lastRun
          ? `${new Date(stats.lastRun.startedAt).toLocaleTimeString()} · ${stats.lastRun.warnings.length} warning(s)`
          : 'not run yet',
      },
    ];
    if (scheduler.nextRunAt) {
      tiles.push({ label: 'Next scrape', value: new Date(scheduler.nextRunAt).toLocaleTimeString(), sub: `every ${Math.round(scheduler.intervalMs / 60000)}m` });
    }
    for (const tile of tiles) {
      root.appendChild(el('div', { class: 'tile' }, [
        el('div', { class: 'label', text: tile.label }),
        el('div', { class: `value${tile.good ? ' good' : ''}`, text: String(tile.value) }),
        el('div', { class: 'sub', text: tile.sub }),
      ]));
    }
  }

  function riskBadges(lot) {
    const badges = [];
    const notes = (lot.valuation && lot.valuation.notes) || [];
    for (const note of notes.slice(0, 2)) {
      badges.push(el('span', { class: 'badge risk', title: note, text: note.split('—')[0].trim().slice(0, 34) }));
    }
    if (lot.deal && lot.deal.marginPct >= 0.5 && lot.deal.profit > 0) {
      badges.push(el('span', { class: 'badge hot', text: 'high margin' }));
    }
    return badges;
  }

  function renderLots() {
    const body = $('#lot-rows');
    body.textContent = '';
    $('#lots-empty').classList.toggle('hidden', state.lots.length > 0);
    for (const lot of state.lots) {
      const deal = lot.deal || {};
      const valuation = lot.valuation || {};
      const row = el('tr', { onclick: () => openDrawer(lot.id) }, [
        el('td', {}, [el('div', { class: 'scorebar' }, [
          el('span', { class: 'num', text: String(deal.score ?? 0) }),
          el('span', { class: 'track' }, [el('span', { class: 'fill', style: `width:${Math.min(deal.score || 0, 100)}%` })]),
        ])]),
        el('td', { class: 'lot-title' }, [
          el('div', { class: 'name', text: lot.title }),
          el('div', { class: 'meta', text: `${lot.source} · ${lot.categoryLabel} · ${lot.condition}${lot.location && lot.location.state ? ` · ${lot.location.state}` : ''}` }),
          el('div', {}, riskBadges(lot)),
        ]),
        el('td', { class: 'num dim', text: String(lot.quantity) }),
        el('td', { class: 'num', text: money(lot.currentBid, lot.currency) }),
        el('td', { class: 'num dim', text: money(deal.maxBid, lot.currency) }),
        el('td', { class: `num ${signClass(deal.profit)}`, text: money(deal.profit, lot.currency) }),
        el('td', { class: `num ${signClass(deal.marginPct)}`, text: pct(deal.marginPct) }),
        el('td', { class: `num ${signClass(deal.roi)}`, text: pct(deal.roi) }),
        el('td', { class: 'num dim', text: pct(valuation.confidence) }),
        el('td', { class: `num ${deal.hoursToClose !== null && deal.hoursToClose <= 12 ? 'warn' : 'dim'}`, text: timeLeft(deal.hoursToClose) }),
      ]);
      body.appendChild(row);
    }
    $('#lot-count').textContent = `Showing ${state.lots.length} of ${state.total} matching lots.`;
  }

  function sparkline(history) {
    if (!history || history.length < 2) return null;
    const values = history.map((point) => point.bid);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const points = values.map((value, i) => {
      const x = (i / (values.length - 1)) * 100;
      const y = 40 - ((value - min) / span) * 34;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 44');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'sparkline');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', points);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', '#58a6ff');
    line.setAttribute('stroke-width', '1.5');
    svg.appendChild(line);
    return svg;
  }

  function kv(rows) {
    const node = el('div', { class: 'kv' });
    for (const [label, value, className] of rows) {
      node.appendChild(el('span', { class: `k ${className || ''}`, text: label }));
      node.appendChild(el('span', { class: `v ${className || ''}`, text: value }));
    }
    return node;
  }

  async function openDrawer(id) {
    let lot;
    try {
      lot = await api(`/api/lots/${encodeURIComponent(id)}`);
    } catch (err) {
      toast(err.message, true);
      return;
    }
    const deal = lot.deal || {};
    const valuation = lot.valuation || {};
    const landed = deal.landed || {};
    const proceeds = deal.proceeds || {};
    const root = $('#drawer-root');
    root.textContent = '';

    const close = () => { root.textContent = ''; };
    root.appendChild(el('div', { class: 'backdrop', onclick: close }));
    root.appendChild(el('div', { class: 'drawer' }, [
      el('button', { class: 'btn secondary close', text: 'Close', onclick: close }),
      el('h2', { text: lot.title }),
      el('p', { class: 'faint', text: `${lot.source} ${lot.externalId} · ${lot.categoryLabel} · ${lot.condition} · qty ${lot.quantity}` }),
      lot.url ? el('p', {}, [el('a', { href: lot.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open the listing ↗' })]) : null,
      (valuation.notes || []).length
        ? el('div', { class: 'note', text: `⚠ ${valuation.notes.join(' · ')}` })
        : null,

      el('section', {}, [
        el('h3', { text: 'Bid guidance' }),
        kv([
          ['Current bid', money(lot.currentBid, lot.currency)],
          [`Max bid at ${pct(deal.targetMarginPct)} margin`, money(deal.maxBid, lot.currency)],
          ['Break-even bid', money(deal.breakEvenBid, lot.currency)],
          ['Headroom', money(deal.headroom, lot.currency), signClass(deal.headroom)],
          ['Closes', lot.closesAt ? new Date(lot.closesAt).toLocaleString() : 'unknown'],
        ]),
      ]),

      el('section', {}, [
        el('h3', { text: `Valuation — ${valuation.method === 'comp' ? valuation.compLabel : 'category default'} (confidence ${pct(valuation.confidence)})` }),
        kv([
          ...(valuation.adjustments || []).map((a) => [
            a.label,
            a.multiplier !== undefined ? `× ${a.multiplier}` : money(a.value),
          ]),
          ['Estimated resale', money(valuation.totalValue), 'total'],
        ]),
      ]),

      el('section', {}, [
        el('h3', { text: 'Cost to own' }),
        kv([
          ['Winning bid', money(landed.bid)],
          ["Buyer's premium", money(landed.premium)],
          ['Sales tax', money(landed.tax)],
          ['Freight in', money(landed.inbound)],
          ['Refurb + listing prep', money(landed.prep)],
          ['Landed cost', money(landed.total), 'total'],
        ]),
      ]),

      el('section', {}, [
        el('h3', { text: 'Sale' }),
        kv([
          [`Gross (sell-through ${pct(proceeds.sellThrough)})`, money(proceeds.gross)],
          ['Marketplace fees', money(-proceeds.fees)],
          ['Outbound shipping', money(-proceeds.outbound)],
          ['Net proceeds', money(proceeds.net), 'total'],
          ['Profit', money(deal.profit), signClass(deal.profit)],
          ['Margin / ROI', `${pct(deal.marginPct)} / ${pct(deal.roi)}`],
          ['Per-unit profit', money(deal.perUnitProfit)],
        ]),
      ]),

      (lot.priceHistory || []).length > 1
        ? el('section', {}, [
          el('h3', { text: `Bid history (${lot.priceHistory.length} points)` }),
          sparkline(lot.priceHistory),
          el('p', { class: 'faint', text: `${money(lot.priceHistory[0].bid)} → ${money(lot.priceHistory[lot.priceHistory.length - 1].bid)}` }),
        ])
        : null,
    ]));
  }

  function renderAlerts() {
    const root = $('#alert-list');
    root.textContent = '';
    if (!state.alerts.length) {
      root.appendChild(el('div', { class: 'empty', text: 'No alerts sent yet. Rules fire on the next scrape that finds a match.' }));
      return;
    }
    for (const alert of state.alerts) {
      const failures = (alert.deliveries || []).filter((d) => !d.ok);
      root.appendChild(el('div', { class: 'card' }, [
        el('h3', {}, [alert.url ? el('a', { href: alert.url, target: '_blank', rel: 'noopener noreferrer', text: alert.title }) : alert.title]),
        el('div', { class: 'faint', text: `${alert.ruleName} · ${alert.reason} · ${new Date(alert.sentAt).toLocaleString()}` }),
        el('div', { class: 'row' }, [
          el('span', { class: `badge ${alert.profit > 0 ? 'hot' : ''}`, text: `${money(alert.profit)} profit` }),
          el('span', { class: 'badge', text: `${pct(alert.marginPct)} margin` }),
          el('span', { class: 'badge', text: `bid ${money(alert.currentBid)}` }),
          el('span', { class: 'badge', text: `max ${money(alert.maxBid)}` }),
          el('span', { class: 'badge', text: `via ${(alert.deliveries || []).map((d) => d.channel).join(', ') || 'none'}` }),
        ]),
        failures.length
          ? el('div', { class: 'note', text: `Delivery failed: ${failures.map((f) => `${f.channel} (${f.error || f.status})`).join(', ')}` })
          : null,
      ]));
    }
  }

  function renderRules() {
    const root = $('#rule-list');
    root.textContent = '';
    for (const rule of state.rules) {
      const filters = Object.entries(rule.filters).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      const thresholds = Object.entries(rule.thresholds).map(([k, v]) => `${k}: ${v}`);
      root.appendChild(el('div', { class: 'card' }, [
        el('h3', { text: `${rule.enabled ? '● ' : '○ '}${rule.name}` }),
        rule.notes ? el('div', { class: 'faint', text: rule.notes }) : null,
        el('div', { class: 'row' }, [...filters, ...thresholds].map((text) => el('span', { class: 'badge', text }))),
        el('div', { class: 'row' }, [
          el('span', { class: 'faint', text: `channels: ${rule.channels.map((c) => c.type).join(', ')} · cooldown ${rule.cooldownMinutes}m · id ${rule.id}` }),
        ]),
        el('div', { class: 'row' }, [
          el('button', {
            class: 'btn secondary',
            text: rule.enabled ? 'Disable' : 'Enable',
            onclick: async () => {
              await api(`/api/rules/${encodeURIComponent(rule.id)}`, { method: 'PUT', body: { enabled: !rule.enabled } });
              await refresh();
            },
          }),
          el('button', {
            class: 'btn danger',
            text: 'Delete',
            onclick: async () => {
              if (!window.confirm(`Delete rule "${rule.name}"?`)) return;
              await api(`/api/rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
              await refresh();
            },
          }),
        ]),
      ]));
    }
  }

  function renderSources() {
    const root = $('#source-list');
    root.textContent = '';
    for (const source of state.sources) {
      root.appendChild(el('div', { class: 'card' }, [
        el('h3', { text: source.label }),
        el('div', { class: 'row' }, [
          el('span', { class: `badge ${source.enabled ? 'hot' : ''}`, text: source.enabled ? 'enabled' : 'disabled' }),
          el('span', { class: 'badge', text: source.id }),
          el('span', { class: 'badge', text: source.kind }),
          el('span', {
            class: `badge ${source.offline || source.verified ? '' : 'risk'}`,
            text: source.offline ? 'offline fixtures' : (source.verified ? 'endpoint verified' : 'endpoint unverified'),
          }),
        ]),
        source.site ? el('div', { class: 'faint', text: source.site }) : null,
        ...(source.notes || []).map((note) => el('p', { class: 'faint', text: note })),
      ]));
    }
    root.appendChild(el('p', { class: 'faint', text: 'Enable sources with the SOURCES environment variable or the "sources" key in dealhunter.config.json.' }));
  }

  // --- data loading -----------------------------------------------------
  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    try {
      const query = new URLSearchParams(currentFilters()).toString();
      const [lots, stats, alerts, rules, sources, categories] = await Promise.all([
        api(`/api/lots?${query}`),
        api('/api/stats'),
        api('/api/alerts?limit=40'),
        api('/api/rules'),
        api('/api/sources'),
        api('/api/categories'),
      ]);
      state.lots = lots.lots;
      state.total = lots.total;
      state.stats = stats;
      state.alerts = alerts.alerts;
      state.rules = rules.rules;
      state.sources = sources.sources;
      state.categories = categories.categories;
      fillSelects();
      renderTiles();
      renderLots();
      renderAlerts();
      renderRules();
      renderSources();
    } catch (err) {
      toast(err.message, true);
    } finally {
      state.loading = false;
    }
  }

  let selectsFilled = false;
  function fillSelects() {
    if (selectsFilled) return;
    selectsFilled = true;
    const categorySelects = [$('#f-category'), document.querySelector('#rule-form select[name="category"]')];
    for (const select of categorySelects) {
      for (const category of state.categories) {
        select.appendChild(el('option', { value: category.id, text: category.label }));
      }
    }
    const seen = new Set(state.lots.map((lot) => lot.source));
    for (const source of state.sources) seen.add(source.id);
    for (const id of Array.from(seen).sort()) {
      $('#f-source').appendChild(el('option', { value: id, text: id }));
    }
  }

  // --- wiring -----------------------------------------------------------
  function selectTab(name) {
    state.tab = name;
    for (const button of document.querySelectorAll('nav.tabs button')) {
      button.setAttribute('aria-selected', String(button.dataset.tab === name));
    }
    for (const section of ['deals', 'alerts', 'rules', 'sources']) {
      document.querySelector(`#tab-${section}`).classList.toggle('hidden', section !== name);
    }
  }

  document.querySelectorAll('nav.tabs button').forEach((button) => {
    button.addEventListener('click', () => selectTab(button.dataset.tab));
  });

  let debounce;
  for (const id of ['#f-q', '#f-category', '#f-source', '#f-margin', '#f-profit', '#f-closing', '#f-confidence', '#f-sort', '#f-all']) {
    const node = $(id);
    node.addEventListener(node.tagName === 'INPUT' && node.type !== 'checkbox' ? 'input' : 'change', () => {
      clearTimeout(debounce);
      debounce = setTimeout(refresh, 250);
    });
  }

  $('#f-reset').addEventListener('click', () => {
    for (const id of ['#f-q', '#f-margin', '#f-profit', '#f-closing', '#f-confidence']) $(id).value = '';
    $('#f-category').value = '';
    $('#f-source').value = '';
    $('#f-sort').value = 'score';
    $('#f-all').checked = false;
    refresh();
  });

  $('#scrape-now').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Scraping…';
    try {
      const summary = await api('/api/scrape', { method: 'POST', body: {} });
      toast(`Scraped ${summary.scraped} listings · ${summary.deals} deals · ${summary.alertsSent} alert(s)`);
      if (summary.warnings.length) toast(summary.warnings[0], true);
      await refresh();
    } catch (err) {
      toast(err.message, true);
    } finally {
      button.disabled = false;
      button.textContent = 'Scrape now';
    }
  });

  $('#rule-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const channelType = form.get('channelType');
    const url = String(form.get('webhook') || '').trim();
    const channels = [{ type: 'console' }];
    if (channelType !== 'console' && url) channels.push({ type: channelType, url });
    try {
      await api('/api/rules', {
        method: 'POST',
        body: {
          name: form.get('name'),
          filters: {
            categories: form.get('category') || undefined,
            states: form.get('state') || undefined,
            keywords: form.get('keywords') || undefined,
            closingWithinHours: form.get('closingWithinHours') || undefined,
          },
          thresholds: {
            minMarginPct: form.get('minMarginPct') || undefined,
            minProfit: form.get('minProfit') || undefined,
            minConfidence: form.get('minConfidence') || undefined,
          },
          channels,
        },
      });
      event.currentTarget.reset();
      toast('Rule added');
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') $('#drawer-root').textContent = '';
  });

  refresh();
  setInterval(refresh, 30000);
}());
