// One RadioStation = one genre = one Discord bot. It owns a Discord client, a
// voice connection, a continuous-play audio loop driven by the Mixer, and a
// small set of slash commands. The same control methods (play/stop/skip/era)
// are reused by the Telegram remote.
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
import { loadCatalog, yearSpan } from './library.js';
import { streamTrack } from './sources/ytdlp.js';
import { makeLog } from './log.js';

const SLASH_COMMANDS = [
  new SlashCommandBuilder().setName('now').setDescription('Show what is playing right now'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip to the next track'),
  new SlashCommandBuilder().setName('station').setDescription('Show station info and current filter'),
  new SlashCommandBuilder()
    .setName('era')
    .setDescription('Only play songs produced within a year range')
    .addIntegerOption((o) => o.setName('from').setDescription('Start year, e.g. 1980').setRequired(true))
    .addIntegerOption((o) => o.setName('to').setDescription('End year, e.g. 1989').setRequired(true)),
  new SlashCommandBuilder().setName('allyears').setDescription('Clear the year filter (play the whole era)'),
].map((c) => c.toJSON());

export class RadioStation {
  constructor({ id, name, emoji, catalogName, token, guildId, voiceId, noRepeat }) {
    this.id = id;
    this.name = name;
    this.emoji = emoji;
    this.token = token;
    this.guildId = guildId;
    this.voiceId = voiceId;
    this.log = makeLog(name);

    const { genre, tracks } = loadCatalog(catalogName);
    this.genre = genre;
    this.span = yearSpan(tracks);
    this.mixer = new Mixer(tracks, noRepeat);

    this.current = null; // currently playing track
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

  // ── lifecycle ──────────────────────────────────────────────────────────────
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

  // ── controls (shared by slash commands and Telegram) ───────────────────────
  resume() {
    if (this.playing) return false;
    this.playing = true;
    this._playNext();
    return true;
  }

  skip() {
    if (!this.connection) return false;
    this.playing = true;
    this._killChild();
    this.player.stop(true); // triggers Idle -> _playNext()
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
      genre: this.genre,
      playing: this.playing,
      connected: !!this.connection,
      current: this.current,
      era: this.mixer.era,
      span: this.span,
    };
  }

  nowPlayingText() {
    if (!this.connection) return `${this.emoji} ${this.name} — not connected to voice.`;
    if (!this.current) return `${this.emoji} ${this.name} — buffering…`;
    const c = this.current;
    const era = this.mixer.era ? ` · filter ${this.mixer.era.from}–${this.mixer.era.to}` : '';
    return `${this.emoji} ${this.name} — now playing: **${c.artist} – ${c.title}** (${c.year})${era}`;
  }

  // ── internals ──────────────────────────────────────────────────────────────
  _wirePlayer() {
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.playing) this._playNext();
    });
    this.player.on('error', (err) => {
      this.log.warn('player error:', err.message);
      this._killChild();
      if (this.playing) setTimeout(() => this._playNext(), 750);
    });
  }

  _wireClient() {
    this.client.once('clientReady', async () => {
      this.log.info(`logged in as ${this.client.user.tag}`);
      await this._registerCommands();
      await this._joinVoice();
      this.playing = true;
      this._playNext();
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
    await rest.put(
      Routes.applicationGuildCommands(this.client.user.id, this.guildId),
      { body: SLASH_COMMANDS },
    );
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
          `${this.emoji} **${this.name}** radio\n` +
            `Catalog: ${this.mixer.tracks.length} tracks · spanning ${this.span.min}–${this.span.max}\n` +
            `Date filter: ${era}`,
        );
      }
      case 'era': {
        const from = i.options.getInteger('from');
        const to = i.options.getInteger('to');
        const r = this.setEra(from, to);
        const msg =
          r.matches > 0
            ? `📅 Now spinning **${this.name}** from **${r.from}–${r.to}** (${r.matches} tracks). Next song respects the new range.`
            : `📅 No ${this.name} tracks in ${r.from}–${r.to}; keeping the full catalog instead.`;
        return i.reply(msg);
      }
      case 'allyears':
        this.clearEra();
        return i.reply('🌐 Year filter cleared — playing the whole era.');
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

    // Survive transient voice gateway drops without killing the station.
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

  _playNext() {
    if (!this.playing || !this.connection) return;

    const track = this.mixer.next();
    this.current = track;
    this._updatePresence();

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
      // Back off a touch and try a different track; cap the spin rate.
      const delay = Math.min(5_000, 500 * this.failStreak);
      if (this.playing) setTimeout(() => this._playNext(), delay);
    }
  }

  _updatePresence() {
    const user = this.client.user;
    if (!user) return;
    if (this.current && this.playing) {
      user.setActivity(`${this.current.artist} – ${this.current.title}`, {
        type: ActivityType.Listening,
      });
    } else {
      user.setActivity(`${this.name} radio`, { type: ActivityType.Listening });
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
