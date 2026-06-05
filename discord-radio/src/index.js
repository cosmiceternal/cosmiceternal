// Entry point. Boots one RadioStation per genre that has a Discord token
// configured, then (optionally) brings up the Telegram remote that controls
// all of them.
import 'dotenv/config';
import ffmpegPath from 'ffmpeg-static';
import { STATIONS, envKeys } from '../config/stations.js';
import { RadioStation } from './station.js';
import { startTelegram } from './telegram.js';
import { checkYtDlp } from './sources/ytdlp.js';
import { log } from './log.js';

// Make sure @discordjs/voice (via prism-media) can find ffmpeg without a
// system install.
if (ffmpegPath) process.env.FFMPEG_PATH = ffmpegPath;

const NO_REPEAT = parseInt(process.env.NO_REPEAT_WINDOW || '12', 10);

async function main() {
  const yt = await checkYtDlp();
  if (!yt.ok) {
    log.error(
      'yt-dlp not found. Install it (e.g. "pipx install yt-dlp" or "brew install yt-dlp") ' +
        'or set YT_DLP_PATH. The radio cannot stream audio without it.',
    );
  } else {
    log.info(`yt-dlp ${yt.version} detected`);
  }

  const stations = new Map();

  for (const def of STATIONS) {
    const keys = envKeys(def.id);
    const token = process.env[keys.token];
    const guildId = process.env[keys.guild];
    const voiceId = process.env[keys.voice];

    if (!token) continue; // station opted out — no token configured

    if (!guildId || !voiceId) {
      log.warn(`${def.name}: ${keys.token} is set but ${keys.guild}/${keys.voice} is missing — skipping.`);
      continue;
    }

    const station = new RadioStation({
      id: def.id,
      name: def.name,
      emoji: def.emoji,
      catalogName: def.catalog,
      token,
      guildId,
      voiceId,
      noRepeat: NO_REPEAT,
    });

    try {
      await station.start();
      stations.set(def.id, station);
    } catch (err) {
      log.error(`${def.name}: failed to log in — ${err.message}`);
    }
  }

  if (stations.size === 0) {
    log.error(
      'No stations started. Set DISCORD_TOKEN_<GENRE> (plus GUILD/VOICE) for at least ' +
        'one station in .env. See .env.example.',
    );
  } else {
    log.info(`Started ${stations.size} station(s): ${[...stations.keys()].join(', ')}`);
  }

  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  if (tgToken && stations.size > 0) {
    const allowed = (process.env.TELEGRAM_ALLOWED_USERS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    startTelegram(tgToken, stations, allowed);
  } else if (!tgToken) {
    log.info('TELEGRAM_BOT_TOKEN not set — running without the Telegram remote.');
  }

  // Tidy shutdown.
  const shutdown = async () => {
    log.info('shutting down…');
    await Promise.allSettled([...stations.values()].map((s) => s.stop()));
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error('fatal:', err);
  process.exit(1);
});
