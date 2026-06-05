// Telegram remote control. One bot drives every running station: list them,
// see now-playing, skip, set/clear the production-date filter, and stop/play.
import { Telegraf } from 'telegraf';
import { makeLog } from './log.js';

const log = makeLog('telegram');

// Resolve a station by id from the first command argument.
function pick(stations, arg) {
  if (!arg) return null;
  return stations.get(arg.toLowerCase()) || null;
}

function stationList(stations) {
  return [...stations.values()]
    .map((s) => {
      const st = s.status();
      const where = st.current ? `${st.current.artist} – ${st.current.title} (${st.current.year})` : (st.connected ? 'buffering…' : 'offline');
      const era = st.era ? ` [${st.era.from}–${st.era.to}]` : '';
      return `${st.emoji} \`${st.id}\` *${st.name}*${era}\n   ${where}`;
    })
    .join('\n');
}

export function startTelegram(token, stations, allowedUsers) {
  const bot = new Telegraf(token);
  const allow = new Set((allowedUsers || []).map(String));

  // Auth gate: if an allow-list is configured, enforce it.
  bot.use(async (ctx, next) => {
    if (allow.size > 0 && !allow.has(String(ctx.from?.id))) {
      await ctx.reply('⛔ Not authorised to control the radio.');
      return;
    }
    return next();
  });

  const help =
    '📻 *Genre Radio control*\n\n' +
    '/stations — list stations & now playing\n' +
    '/now `<id>` — what a station is playing\n' +
    '/skip `<id>` — next track\n' +
    '/era `<id> <from> <to>` — only songs from a year range\n' +
    '/allyears `<id>` — clear the year filter\n' +
    '/stop `<id>` — pause a station\n' +
    '/play `<id>` — resume a station';

  bot.start((ctx) => ctx.replyWithMarkdown(help));
  bot.help((ctx) => ctx.replyWithMarkdown(help));

  bot.command('stations', (ctx) => {
    if (stations.size === 0) return ctx.reply('No stations are running.');
    ctx.replyWithMarkdown(stationList(stations));
  });

  bot.command('now', (ctx) => {
    const s = pick(stations, ctx.payload?.trim());
    if (!s) return ctx.reply('Usage: /now <station-id>. See /stations.');
    ctx.reply(s.nowPlayingText());
  });

  bot.command('skip', (ctx) => {
    const s = pick(stations, ctx.payload?.trim());
    if (!s) return ctx.reply('Usage: /skip <station-id>. See /stations.');
    s.skip();
    ctx.reply(`⏭️ ${s.name}: skipping…`);
  });

  bot.command('era', (ctx) => {
    const [id, from, to] = (ctx.payload || '').trim().split(/\s+/);
    const s = pick(stations, id);
    if (!s || !from || !to || Number.isNaN(+from) || Number.isNaN(+to)) {
      return ctx.reply('Usage: /era <station-id> <fromYear> <toYear>\nExample: /era rock 1970 1979');
    }
    const r = s.setEra(parseInt(from, 10), parseInt(to, 10));
    ctx.reply(
      r.matches > 0
        ? `📅 ${s.name}: now ${r.from}–${r.to} (${r.matches} tracks). Takes effect on the next song.`
        : `📅 ${s.name}: no tracks in ${r.from}–${r.to}; kept the full catalog.`,
    );
  });

  bot.command('allyears', (ctx) => {
    const s = pick(stations, ctx.payload?.trim());
    if (!s) return ctx.reply('Usage: /allyears <station-id>. See /stations.');
    s.clearEra();
    ctx.reply(`🌐 ${s.name}: year filter cleared.`);
  });

  bot.command('stop', (ctx) => {
    const s = pick(stations, ctx.payload?.trim());
    if (!s) return ctx.reply('Usage: /stop <station-id>. See /stations.');
    s.playing = false;
    s._killChild();
    s.player.stop(true);
    s._updatePresence();
    ctx.reply(`⏸️ ${s.name}: paused.`);
  });

  bot.command('play', (ctx) => {
    const s = pick(stations, ctx.payload?.trim());
    if (!s) return ctx.reply('Usage: /play <station-id>. See /stations.');
    s.resume();
    ctx.reply(`▶️ ${s.name}: playing.`);
  });

  bot.catch((err, ctx) => log.warn(`update ${ctx.updateType} failed:`, err.message));

  bot.launch().then(() => log.info('Telegram control online')).catch((e) => log.error('launch failed:', e.message));

  // Graceful stop signals so polling shuts down cleanly.
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
  return bot;
}
