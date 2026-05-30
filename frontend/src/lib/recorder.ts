// Microphone capture that produces a 16 kHz mono 16-bit PCM WAV blob — the
// format Azure's pronunciation-assessment REST endpoint accepts directly, so
// the backend never has to transcode. Uses ScriptProcessorNode: deprecated but
// universally supported and dependency-free, which is the right trade for a
// personal app targeting modern browsers.

const TARGET_RATE = 16000;

export interface ActiveRecording {
  /** Stop capture, release the mic, and return the recorded clip as WAV. */
  stop(): Promise<Blob>;
  /** Abort without producing a clip (e.g. user cancelled); releases the mic. */
  cancel(): void;
}

export function isRecordingSupported(): boolean {
  return Boolean(
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
      (window.AudioContext ||
        (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext),
  );
}

export async function startRecording(): Promise<ActiveRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });

  const AudioCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  // Request 16 kHz directly; browsers that ignore it fall back to the hardware
  // rate and we downsample in stop().
  const ctx = new AudioCtor({ sampleRate: TARGET_RATE });
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  // Route through a muted gain node so onaudioprocess keeps firing (some
  // browsers gate it on being connected to the destination) without playing
  // the mic back through the speakers.
  const silent = ctx.createGain();
  silent.gain.value = 0;

  const chunks: Float32Array[] = [];
  let stopped = false;
  processor.onaudioprocess = (e) => {
    if (stopped) return;
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };

  source.connect(processor);
  processor.connect(silent);
  silent.connect(ctx.destination);

  const release = () => {
    stopped = true;
    processor.onaudioprocess = null;
    try {
      processor.disconnect();
      source.disconnect();
      silent.disconnect();
    } catch {
      // disconnect can throw if already torn down; ignore.
    }
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };

  return {
    async stop() {
      const inputRate = ctx.sampleRate;
      release();
      const merged = mergeChunks(chunks);
      const samples =
        inputRate === TARGET_RATE ? merged : downsample(merged, inputRate, TARGET_RATE);
      return encodeWav(samples, TARGET_RATE);
    },
    cancel() {
      release();
    },
  };
}

function mergeChunks(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function downsample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate >= inRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = idx - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += bytesPerSample;
  }
  return new Blob([view], { type: 'audio/wav' });
}
