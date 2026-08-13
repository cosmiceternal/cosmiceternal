// One RadioStation = one genre = one Discord bot, run like a real radio station.
// It owns a Discord client, a voice connection, and a continuous *broadcast* loop
// driven by the Director: songs interleaved with DJ talk, station idents and ad
// breaks. Songs stream from yt-dlp; spoken segments come from the voice-over
// source. The same controls (play/stop/skip/era) are reused by the Telegram remote.
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActivityType,
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';
import { Mixer } from './mixer.js';
import { Director } from './broadcast.js';
import { loadCatalog, yearSpan } from './library.js';
import { streamTrack } from './sources/ytdlp.js';
import { makeLog } from './log.js';

const SLASH_COMMANDS = [
  new SlashCommandBuilder().setName('now').setDescription('What is on the air right now'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current segment'),
  new SlashCommandBuilder().setName('station').setDescription('Station info: DJ, call sign, current filter'),
  new SlashCommandBuilder()
    .setName('era')
    .setDescription('Only play songs produced within a year range')
    .addIntegerOption((o) => o.setName('from').setDescription('Start year, e.g. 1980').setRequired(true))
    .addIntegerOption((o) => o.setName('to').setDescription('End year, e.g. 1989').setRequired(true)),
  new SlashCommandBuilder().setName('allyears').setDescription('Clear the year filter (play the whole era)'),
].map((c) => c.toJSON());

// How a spoken segment reads in the on-air ticker.
const SEG_LABEL = {
  ident: '📻 Station ID',
  dj: '🎙️ On the mic',
  ad: '📢 Commercial break',
};

export class RadioStation {
  constructor(opts) {
    const { def, token, guildId, voiceId, textId, voice, dj, noRepeat } = opts;
    this.id = def.id;
    this.name = def.name;
    this.emoji = def.emoji;
    this.callSign = def.callSign;
    this.short = def.short;
    this.slogan = def.slogan;
    this.djName = def.dj.name;
    this.token = token;
    this.guildId = guildId;
    this.voiceId = voiceId;
    this.textId = textId;
    this.voice = voice; // voice-over source
    this.log = makeLog(def.short);

    const { genre, tracks } = loadCatalog(def.catalog);
    this.genre = genre;
    this.span = yearSpan(tracks);
    this.mixer = new Mixer(tracks, noRepeat);
    this.director = new Director({ ...def, genre }, this.mixer, dj);

    this.current = null; // current segment { type, text?, track? }
    this.nowTrack = null; // last song segment, for display
    this.playing = false;
    this.child = null; // active yt-dlp process
    this.failStreak = 0;

    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    this._wirePlayer();
    this._wireClient();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  async start() {
    await this.client.login(this.token);
  }

  async stop() {
    this.playing = false;
    this._killChild();
    this.player.stop(true);
    this.connection?.destroy();
    this.connection = null;
    this.current = null;
    this._updatePresence();
  }

  // ── controls (shared by slash commands and Telegram) ────────────────────────
  resume() {
    if (this.playing) return false;
    this.playing = true;
    this._advance();
    return true;
  }

  pause() {
    this.playing = false;
    this._killChild();
    this.player.stop(true);
    this._updatePresence();
  }

  skip() {
    if (!this.connection) return false;
    this.playing = true;
    this._killChild();
    this.player.stop(true); // triggers Idle -> _advance()
    return true;
  }

  setEra(from, to) {
    const matches = this.mixer.setEra(from, to);
    return { from: this.mixer.era.from, to: this.mixer.era.to, matches };
  }

  clearEra() {
    this.mixer.clearEra();
  }

  status() {
    return {
      id: this.id,
      name: this.name,
      emoji: this.emoji,
      callSign: this.callSign,
      short: this.short,
      dj: this.djName,
      genre: this.genre,
      playing: this.playing,
      connected: !!this.connection,
      segment: this.current, // what's airing right now
      track: this.nowTrack, // last song
      era: this.mixer.era,
      span: this.span,
    };
  }

  // A single-line "what's on air" summary, used by /now and Telegram.
  nowPlayingText() {
    if (!this.connection) return `${this.emoji} ${this.callSign} — off air.`;
    const seg = this.current;
    if (!seg) return `${this.emoji} ${this.callSign} — tuning in…`;
    const era = this.mixer.era ? ` · era ${this.mixer.era.from}–${this.mixer.era.to}` : '';

    if (seg.type === 'song') {
      const t = seg.track;
      return `${this.emoji} ${this.callSign} — 🎵 now playing: **${t.artist} – ${t.title}** (${t.year})${era}`;
    }
    const label = SEG_LABEL[seg.type] || 'On air';
    const who = seg.type === 'dj' ? ` (${this.djName})` : '';
    return `${this.emoji} ${this.callSign} — ${label}${who}: “${seg.text}”`;
  }

  // ── internals ─────────────────────────────────────────────────────────────
  _wirePlayer() {
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.playing) this._advance();
    });
    this.player.on('error', (err) => {
      this.log.warn('player error:', err.message);
      this._killChild();
      if (this.playing) setTimeout(() => this._advance(), 500);
    });
  }

  _wireClient() {
    this.client.once('clientReady', async () => {
      this.log.info(`${this.callSign} — on the air as ${this.client.user.tag}`);
      await this._registerCommands();
      await this._joinVoice();
      this.playing = true;
      this._advance();
    });

    this.client.on('interactionCreate', async (i) => {
      if (!i.isChatInputCommand()) return;
      try {
        await this._handleCommand(i);
      } catch (err) {
        this.log.warn('command error:', err.message);
        if (!i.replied) await i.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
      }
    });
  }

  async _registerCommands() {
    const rest = new REST({ version: '10' }).setToken(this.token);
    await rest.put(Routes.applicationGuildCommands(this.client.user.id, this.guildId), {
      body: SLASH_COMMANDS,
    });
  }

  async _handleCommand(i) {
    switch (i.commandName) {
      case 'now':
        return i.reply(this.nowPlayingText());
      case 'skip':
        this.skip();
        return i.reply('⏭️ Skipping…');
      case 'station': {
        const era = this.mixer.era
          ? `${this.mixer.era.from}–${this.mixer.era.to}`
          : `all years (${this.span.min}–${this.span.max})`;
        return i.reply(
          `${this.emoji} **${this.callSign}** — ${this.slogan}\n` +
            `🎙️ Your host: **${this.djName}**\n` +
            `Catalog: ${this.mixer.tracks.length} tracks · ${this.span.min}–${this.span.max}\n` +
            `Date filter: ${era}`,
        );
      }
      case 'era': {
        const from = i.options.getInteger('from');
        const to = i.options.getInteger('to');
        const r = this.setEra(from, to);
        return i.reply(
          r.matches > 0
            ? `📅 ${this.short} is now spinning **${r.from}–${r.to}** (${r.matches} tracks). Takes effect on the next song.`
            : `📅 No ${this.name} in ${r.from}–${r.to}; keeping the full catalog.`,
        );
      }
      case 'allyears':
        this.clearEra();
        return i.reply('🌐 Year filter cleared — back to the full era.');
      default:
        return i.reply({ content: 'Unknown command.', ephemeral: true });
    }
  }

  async _joinVoice() {
    this.connection = joinVoiceChannel({
      channelId: this.voiceId,
      guildId: this.guildId,
      adapterCreator: this.client.guilds.cache.get(this.guildId).voiceAdapterCreator,
      selfDeaf: true,
    });
    this.connection.subscribe(this.player);

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.log.warn('voice disconnected; tearing down connection');
        this.connection?.destroy();
        this.connection = null;
      }
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000).catch(() => {
      this.log.warn('voice connection not ready within 20s; will keep trying to play');
    });
  }

  // Advance the broadcast by one segment.
  async _advance() {
    if (!this.playing || !this.connection) return;

    let seg;
    try {
      seg = await this.director.next();
    } catch (err) {
      this.log.warn('director error:', err.message);
      return setTimeout(() => this._advance(), 500);
    }

    this.current = seg;
    if (seg.type === 'song') this.nowTrack = seg.track;
    this._updatePresence();
    this._announce(seg);

    if (seg.type === 'song') return this._playSong(seg.track);
    return this._playSpoken(seg);
  }

  _playSong(track) {
    try {
      this._killChild();
      const { resource, child } = streamTrack(track);
      this.child = child;
      child.on('close', (code) => {
        if (code && code !== 0 && this.child === child) {
          this.log.warn(`yt-dlp exited ${code} for "${track.query}": ${child._stderrTail?.() || ''}`);
        }
      });
      this.player.play(resource);
      this.failStreak = 0;
      this.log.info(`▶ ${track.artist} – ${track.title} (${track.year})`);
    } catch (err) {
      this.failStreak += 1;
      this.log.warn(`failed to start "${track.query}": ${err.message}`);
      const delay = Math.min(5_000, 500 * this.failStreak);
      if (this.playing) setTimeout(() => this._advance(), delay);
    }
  }

  // Render a spoken segment (ident / DJ / ad). If the voice-over source returns
  // no audio (text-only mode), just move on to the next segment.
  _playSpoken(seg) {
    let resource = null;
    try {
      resource = this.voice.render(seg);
    } catch (err) {
      this.log.warn('voice-over error:', err.message);
    }
    if (resource) {
      this._killChild();
      this.player.play(resource);
      this.log.info(`🎙️ ${seg.type}: ${seg.text.slice(0, 60)}${seg.text.length > 60 ? '…' : ''}`);
    } else {
      // Text-only: no audio to wait on; continue after a brief beat.
      setTimeout(() => this._advance(), 250);
    }
  }

  // Post the on-air ticker to the optional text channel.
  _announce(seg) {
    if (!this.textId) return;
    const ch = this.client.channels.cache.get(this.textId);
    if (!ch || !ch.isTextBased?.()) return;
    let msg;
    if (seg.type === 'song') {
      msg = `${this.emoji} **${this.callSign}** 🎵 ${seg.track.artist} – ${seg.track.title} (${seg.track.year})`;
    } else if (seg.type === 'dj') {
      msg = `🎙️ **${this.djName}:** ${seg.text}`;
    } else if (seg.type === 'ad') {
      msg = `📢 *${seg.text}*`;
    } else {
      msg = `📻 ${seg.text}`;
    }
    ch.send(msg).catch(() => {});
  }

  _updatePresence() {
    const user = this.client.user;
    if (!user) return;
    const seg = this.current;
    if (seg?.type === 'song' && this.playing) {
      user.setActivity(`${seg.track.artist} – ${seg.track.title}`, { type: ActivityType.Listening });
    } else if (seg && this.playing) {
      const label = seg.type === 'ad' ? 'a word from our sponsors' : `${this.djName} on the mic`;
      user.setActivity(label, { type: ActivityType.Playing });
    } else {
      user.setActivity(this.callSign, { type: ActivityType.Listening });
    }
  }

  _killChild() {
    if (this.child) {
      this.child.removeAllListeners('close');
      this.child.kill('SIGKILL');
      this.child = null;
    }
  }
}
