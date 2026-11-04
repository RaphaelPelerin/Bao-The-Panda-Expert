/** Male voices that ship with Windows, macOS and Edge, by name. Bao is a male character. */
const MALE_LOCAL_VOICE =
  /\b(david|mark|guy|ryan|christopher|eric|george|james|richard|alex|daniel|fred|tom|aaron|arthur|oliver|paul|claude|henri|remy|antoine|thomas|nicolas|kangkang|yunxi|yunyang|yunjian|yunxia|li-mu)\b/i;

export function isMaleVoiceName(name: string): boolean {
  return MALE_LOCAL_VOICE.test(name);
}

/** Decodes 16-bit little-endian PCM. A chunk can end mid-sample: the leftover byte is returned for the next one. */
export function decodePcm(bytes: Uint8Array): { samples: Float32Array; leftover: Uint8Array } {
  const count = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return { samples, leftover: bytes.slice(count * 2) };
}
