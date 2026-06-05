// Loads a genre's year-tagged track catalog from data/catalog/<name>.json.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = join(__dirname, '..', 'data', 'catalog');

export function loadCatalog(name) {
  const file = join(CATALOG_DIR, `${name}.json`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const tracks = (raw.tracks || [])
    .filter((t) => t && t.title && t.artist && Number.isInteger(t.year))
    .map((t) => ({
      title: String(t.title),
      artist: String(t.artist),
      year: t.year,
      // The query handed to yt-dlp's ytsearch. "audio" biases toward full songs.
      query: `${t.artist} ${t.title} audio`,
    }));
  if (tracks.length === 0) {
    throw new Error(`Catalog "${name}" has no valid tracks`);
  }
  return { genre: raw.genre || name, tracks };
}

// Min/max production year present in a catalog — handy for "/era" hints.
export function yearSpan(tracks) {
  const years = tracks.map((t) => t.year);
  return { min: Math.min(...years), max: Math.max(...years) };
}
