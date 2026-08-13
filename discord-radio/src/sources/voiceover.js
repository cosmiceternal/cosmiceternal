// Voice-over source: turns an on-air text segment (ident / DJ talk / ad) into an
// AudioResource so the station literally *talks* between songs — the GTA feel.
//
// Two ways it renders, chosen automatically:
//   • TTS  — if TTS_CMD is set, a text-to-speech command speaks the line.
//            Contract: TTS_CMD reads the text on STDIN and writes WAV/audio to
//            STDOUT. Works with, e.g.:
//              TTS_CMD="espeak-ng --stdout"
//              TTS_CMD="piper --model en_US-lessac-medium.onnx --output_file -"
//   • Sting — no TTS? Idents still get a short synthesized station stinger via
//            ffmpeg, and DJ/ad segments fall back to on-air TEXT only (posted to
//            the channel, no audio gap) so the music keeps flowing.
import { spawn } from 'node:child_process';
import { createAudioResource, StreamType } from '@discordjs/voice';
import ffmpegPath from 'ffmpeg-static';

export function createVoiceOver() {
  const cmd = (process.env.TTS_CMD || '').trim();

  return {
    ttsEnabled: !!cmd,

    // Returns an AudioResource, or null meaning "no audio — text only".
    render(segment) {
      if (cmd) return speak(cmd, segment.text);
      if (segment.type === 'ident') return sting();
      return null;
    },
  };
}

// Speak text via the configured TTS command (stdin -> stdout audio).
function speak(cmd, text) {
  const child = spawn('sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.on('error', (err) => child.stdout?.destroy(err));
  child.stdin.on('error', () => {}); // ignore EPIPE if the tool exits early
  child.stdin.write(text);
  child.stdin.end();
  return createAudioResource(child.stdout, { inputType: StreamType.Arbitrary });
}

// A short two-note station stinger, synthesized by ffmpeg (no assets needed).
function sting() {
  if (!ffmpegPath) return null;
  const child = spawn(
    ffmpegPath,
    [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.28',
      '-f', 'lavfi', '-i', 'sine=frequency=990:duration=0.32',
      '-filter_complex', '[0][1]concat=n=2:v=0:a=1,afade=t=out:st=0.45:d=0.15,volume=0.35',
      '-f', 'wav', 'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  child.on('error', (err) => child.stdout?.destroy(err));
  return createAudioResource(child.stdout, { inputType: StreamType.Arbitrary });
}
