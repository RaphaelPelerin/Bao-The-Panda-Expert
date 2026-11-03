const TARGET_RATE = 16_000;

export function mergeSamples(chunks: Float32Array[]): Float32Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Linear resample. Browsers often capture at 48 kHz even when 16 kHz was requested. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const length = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(length);
  const scale = fromRate / toRate;
  for (let i = 0; i < length; i++) {
    const pos = i * scale;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const mix = pos - left;
    out[i] = input[left] * (1 - mix) + input[right] * mix;
  }
  return out;
}

/** 16 kHz mono float samples for the local Whisper model. */
export function prepareAudio(chunks: Float32Array[], sampleRate: number): Float32Array {
  return resample(mergeSamples(chunks), sampleRate, TARGET_RATE);
}

export const WHISPER_RATE = TARGET_RATE;
