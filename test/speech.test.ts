import { describe, expect, it } from "vitest";
import { isCloudVoice } from "../src/voice/tts";
import { prepareAudio, resample } from "../src/voice/wav";

describe("local speech helpers", () => {
  it("rejects Google and Online voices, keeps local Microsoft ones", () => {
    expect(isCloudVoice({ name: "Google 普通话", voiceURI: "Google 普通话" })).toBe(true);
    expect(isCloudVoice({ name: "Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)" })).toBe(true);
    expect(isCloudVoice({ name: "Microsoft Xiaoxiao - Chinese (Simplified, PRC)" })).toBe(false);
  });

  it("resamples mic audio down to 16 kHz for Whisper", () => {
    expect(resample(new Float32Array(48), 48_000, 16_000).length).toBe(16);
    expect(prepareAudio([new Float32Array(48_000)], 48_000).length).toBe(16_000);
  });
});
