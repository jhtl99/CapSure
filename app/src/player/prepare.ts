/**
 * Turn a downloaded .cap into something the phone can play.
 *
 * There is no MJPEG codec on iOS and no container we could have used without
 * making the firmware do work it cannot afford. So playback is assembled here
 * out of two things every phone already does well:
 *
 *   - video: JPEG frames written to disk, shown one at a time by <Image>
 *   - audio: the PCM packets concatenated into a WAV file, played normally
 *
 * The audio player is the clock. Every frame carries a pts_us from the same
 * device clock as the audio, so the player just asks "where is the audio" and
 * shows the frame belonging to that moment. Sync is a lookup, not a guess.
 *
 * At 480p15 this is comfortable -- 15 image swaps a second is nothing.
 */

import { Directory, File, Paths } from 'expo-file-system';

import { indexClip, payloadOf, PacketType } from '../device/clip';
import type { ClipIndex } from '../device/clip';
import { buildWav } from './wav';

export interface PreparedClip {
  index: ClipIndex;
  /** file:// URIs, one per video packet, in presentation order. */
  frameUris: string[];
  /** file:// URI of the WAV built from the clip's audio packets. */
  audioUri: string | null;
  durationMs: number;
}

export interface PrepareProgress {
  stage: 'reading' | 'frames' | 'audio' | 'done';
  fraction: number;
}

function workDir(clipId: string): Directory {
  const dir = new Directory(Paths.cache, 'prepared', clipId);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export async function prepareClip(
  clipId: string,
  clipFile: File,
  onProgress?: (p: PrepareProgress) => void
): Promise<PreparedClip> {
  onProgress?.({ stage: 'reading', fraction: 0 });

  const bytes = await clipFile.bytes();
  const index = indexClip(bytes);
  const dir = workDir(clipId);

  // --- video ---------------------------------------------------------
  onProgress?.({ stage: 'frames', fraction: 0 });
  const frameUris: string[] = [];

  for (let i = 0; i < index.video.length; i++) {
    const ref = index.video[i];
    const frameFile = new File(dir, `f${String(i).padStart(5, '0')}.jpg`);
    // Re-preparing a clip that is already unpacked is common (open, back,
    // open again), so skip anything already on disk.
    if (!frameFile.exists) {
      frameFile.create();
      frameFile.write(payloadOf(bytes, ref));
    }
    frameUris.push(frameFile.uri);

    if (i % 30 === 0) {
      onProgress?.({ stage: 'frames', fraction: i / index.video.length });
      // Yield so the progress bar actually moves.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // --- audio ---------------------------------------------------------
  let audioUri: string | null = null;
  if (index.audio.length) {
    onProgress?.({ stage: 'audio', fraction: 0 });
    const wavFile = new File(dir, 'audio.wav');
    if (!wavFile.exists) {
      const chunks = index.audio.map((ref) => payloadOf(bytes, ref));
      const wav = buildWav(chunks, {
        sampleRate: index.header.audioSampleRate,
        bitsPerSample: index.header.audioBits,
        channels: index.header.audioChannels,
      });
      wavFile.create();
      wavFile.write(wav);
    }
    audioUri = wavFile.uri;
  }

  onProgress?.({ stage: 'done', fraction: 1 });

  return {
    index,
    frameUris,
    audioUri,
    durationMs: index.durationUs / 1000,
  };
}

/** Frame packet types, re-exported so screens do not import the parser. */
export { PacketType };

export function clearPrepared(clipId: string): void {
  const dir = new Directory(Paths.cache, 'prepared', clipId);
  if (dir.exists) dir.delete();
}
