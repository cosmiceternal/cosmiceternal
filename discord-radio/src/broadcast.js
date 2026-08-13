// The broadcast director — the station's "hot clock". Instead of just playing
// the next song, it programs a continuous sequence of on-air SEGMENTS the way a
// real (GTA-style) station does: station idents, DJ intros over the top of songs,
// back-announces, banter, and ad breaks — with music as the backbone.
//
// A segment is: { type: 'song'|'ident'|'dj'|'ad', text?, track?, kind? }
//   song  -> streamed from the music source (yt-dlp)
//   ident -> a station-identification liner (spoken / stinger)
//   dj    -> the host talking (spoken, optionally AI-generated)
//   ad    -> a commercial (spoken)

import {
  IDENTS,
  TIME_IDENTS,
  DJ_INTROS,
  DJ_BACK,
  DJ_BANTER,
  GENRE_BANTER,
  decadeOf,
  partOfDay,
  pick,
} from '../config/imaging.js';
import { pickAd } from '../config/ads.js';

// Tuning for the clock — how often non-music elements air.
const IDENT_EVERY_SONGS = 3; // station ident roughly every N songs
const SONGS_PER_AD_BREAK = 4; // ad break after this many songs
const P_DJ_INTRO = 0.6; // chance a song gets a DJ intro
const P_DJ_BACK = 0.25; // chance a song gets a back-announce
const P_BANTER = 0.15; // chance of standalone banter instead

export class Director {
  /**
   * @param {object}  station  station branding (callSign, slogan, dj, genre, …)
   * @param {Mixer}   mixer    genre+date song selector
   * @param {object}  dj       AI DJ (optional); { available, line(kind,ctx,fallback) }
   */
  constructor(station, mixer, dj) {
    this.station = station;
    this.mixer = mixer;
    this.dj = dj;
    this.queue = [];
    this.songsSinceAd = 0;
    this.songsSinceIdent = IDENT_EVERY_SONGS; // open the hour with an ident
    this.lastTrack = null;
  }

  // Pull the next segment, programming a fresh block when the queue runs dry.
  async next() {
    if (this.queue.length === 0) await this._program();
    return this.queue.shift();
  }

  // Fill common placeholders for a text template.
  _fill(tpl, track) {
    const s = this.station;
    const map = {
      callSign: s.callSign,
      short: s.short,
      slogan: s.slogan,
      dj: s.dj.name,
      genre: s.genre,
      artist: track?.artist ?? '',
      title: track?.title ?? '',
      year: track?.year ?? '',
      decade: track ? decadeOf(track.year) : '',
    };
    return tpl.replace(/\{(\w+)\}/g, (_, k) => (k in map ? String(map[k]) : `{${k}}`));
  }

  _ident() {
    // Occasionally use a time-of-day ident for that "live" feel.
    const useTime = Math.random() < 0.4;
    const tpl = useTime ? pick(TIME_IDENTS[partOfDay(new Date().getHours())]) : pick(IDENTS);
    return { type: 'ident', kind: 'ident', text: this._fill(tpl) };
  }

  _liner(tpl) {
    return { type: 'ident', kind: 'liner', text: this._fill(tpl) };
  }

  _ad() {
    return { type: 'ad', kind: 'ad', text: pickAd() };
  }

  _song(track) {
    return { type: 'song', track };
  }

  // Build a DJ segment. Uses a scripted line as the fallback; if an AI DJ is
  // configured, it rewrites the line in character (with the scripted line as a
  // safety net so audio never stalls).
  async _dj(kind, track) {
    const pool = kind === 'intro' ? DJ_INTROS : kind === 'back' ? DJ_BACK : this._banterPool();
    const scripted = this._fill(pick(pool), track);
    let text = scripted;
    if (this.dj?.available) {
      const ctx = {
        callSign: this.station.callSign,
        dj: this.station.dj.name,
        style: this.station.dj.style,
        slogan: this.station.slogan,
        genre: this.station.genre,
        artist: track?.artist,
        title: track?.title,
        year: track?.year,
      };
      text = await this.dj.line(kind, ctx, scripted);
    }
    return { type: 'dj', kind, text };
  }

  _banterPool() {
    const flavour = GENRE_BANTER[this.station.id] || [];
    return [...DJ_BANTER, ...flavour];
  }

  // Program the next block of the hour into the queue.
  async _program() {
    // 1) Station ident on cadence.
    if (this.songsSinceIdent >= IDENT_EVERY_SONGS) {
      this.queue.push(this._ident());
      this.songsSinceIdent = 0;
    }

    // 2) Ad break on cadence: lead-in liner, 1–2 ads, ident back out.
    if (this.songsSinceAd >= SONGS_PER_AD_BREAK) {
      this.queue.push(this._liner("Don't touch that dial — back after these on {callSign}."));
      const count = 1 + (Math.random() < 0.5 ? 1 : 0);
      for (let i = 0; i < count; i++) this.queue.push(this._ad());
      this.queue.push(this._ident());
      this.songsSinceAd = 0;
      this.songsSinceIdent = 0;
    }

    // 3) The song — the backbone — optionally wrapped in DJ talk.
    const track = this.mixer.next();
    this.lastTrack = track;

    if (Math.random() < P_DJ_INTRO) this.queue.push(await this._dj('intro', track));
    this.queue.push(this._song(track));
    this.songsSinceAd += 1;
    this.songsSinceIdent += 1;

    // 4) A little something on the way out.
    const r = Math.random();
    if (r < P_DJ_BACK) this.queue.push(await this._dj('back', track));
    else if (r < P_DJ_BACK + P_BANTER) this.queue.push(await this._dj('banter', null));
  }
}
