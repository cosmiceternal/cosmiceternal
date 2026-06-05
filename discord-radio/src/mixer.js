// The "DJ": picks the next track for a station by mixing on genre (the catalog
// it's handed) and production date (an optional year-range filter), while
// avoiding recent repeats so a long session never feels loopy.

export class Mixer {
  /**
   * @param {Array<{title,artist,year,query}>} tracks  the genre catalog
   * @param {number} noRepeatWindow  how many recent tracks to avoid reusing
   */
  constructor(tracks, noRepeatWindow = 12) {
    this.tracks = tracks;
    this.noRepeatWindow = Math.max(0, noRepeatWindow);
    this.recent = []; // queries of recently played tracks
    this.era = null; // { from:Number, to:Number } | null  => "songs by date produced"
  }

  // Constrain selection to a production-year range. Returns how many tracks match.
  setEra(from, to) {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const matches = this.tracks.filter((t) => t.year >= lo && t.year <= hi).length;
    this.era = { from: lo, to: hi };
    return matches;
  }

  clearEra() {
    this.era = null;
  }

  // Tracks eligible under the current era filter (falls back to all if a filter
  // would leave nothing to play).
  _pool() {
    if (!this.era) return this.tracks;
    const filtered = this.tracks.filter(
      (t) => t.year >= this.era.from && t.year <= this.era.to,
    );
    return filtered.length > 0 ? filtered : this.tracks;
  }

  // Pick the next track: random within the genre+era pool, skipping anything in
  // the recent window unless that would leave us with nothing.
  next() {
    const pool = this._pool();
    const window = Math.min(this.noRepeatWindow, Math.max(0, pool.length - 1));
    const recentSet = new Set(this.recent.slice(-window));

    let candidates = pool.filter((t) => !recentSet.has(t.query));
    if (candidates.length === 0) candidates = pool;

    const track = candidates[Math.floor(Math.random() * candidates.length)];

    this.recent.push(track.query);
    if (this.recent.length > this.noRepeatWindow * 2 + 4) {
      this.recent = this.recent.slice(-(this.noRepeatWindow + 2));
    }
    return track;
  }
}
