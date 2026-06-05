// Audio source: resolve a track's search query to a live audio stream via
// yt-dlp, and wrap it as a @discordjs/voice AudioResource. Streaming straight
// from yt-dlp's stdout (best audio, no playlist) gives gapless, long-running
// playback without buffering whole files to disk.
import { spawn } from 'node:child_process';
import { createAudioResource, StreamType } from '@discordjs/voice';

const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp';

// Spawn yt-dlp and return { resource, child }. The caller plays `resource`;
// `child` is killed when playback ends or is skipped.
export function streamTrack(track) {
  const args = [
    `ytsearch1:${track.query}`,
    '-f', 'bestaudio/best',
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    '-o', '-', // stream to stdout
  ];

  const child = spawn(YT_DLP, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Surface fatal spawn problems (e.g. yt-dlp not installed) clearly.
  child.on('error', (err) => {
    child.stdout?.destroy(err);
  });

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  child._stderrTail = () => stderr.trim();

  const resource = createAudioResource(child.stdout, {
    inputType: StreamType.Arbitrary, // let ffmpeg demux/transcode whatever yt-dlp emits
    metadata: track,
  });

  return { resource, child };
}

// Quick preflight so we can warn the operator instead of failing silently.
export function checkYtDlp() {
  return new Promise((resolve) => {
    const child = spawn(YT_DLP, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve({ ok: false }));
    child.on('close', (code) =>
      resolve(code === 0 ? { ok: true, version: out.trim() } : { ok: false }),
    );
  });
}
