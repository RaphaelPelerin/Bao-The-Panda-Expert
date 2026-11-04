import { describe, expect, it } from "vitest";
import { LANGS } from "../shared/protocol";
import { isCloudVoice } from "../src/voice/tts";
import { chooseEngine, isMaleVoiceName, PIPER_VOICES, voiceNotice } from "../src/voice/voiceStatus";
import { prepareAudio, resample } from "../src/voice/wav";

describe("voice selection", () => {
  it("prefers Piper, then a local voice, then silence", () => {
    expect(chooseEngine("en", true, "Microsoft David")).toBe("piper");
    expect(chooseEngine("en", true, null)).toBe("piper");
    expect(chooseEngine("en", false, "Microsoft David")).toBe("local");
    expect(chooseEngine("en", false, null)).toBe("silent");
  });

  it("keeps Bao male in Chinese, where the Piper voice is female", () => {
    expect(chooseEngine("zh", true, "Microsoft Kangkang")).toBe("local");
    expect(chooseEngine("zh", true, "Microsoft Huihui")).toBe("piper");
    expect(chooseEngine("zh", true, null)).toBe("piper");
  });

  it("recognizes male local voices by name", () => {
    expect(isMaleVoiceName("Microsoft Paul - French (France)")).toBe(true);
    expect(isMaleVoiceName("Microsoft David - English (United States)")).toBe(true);
    expect(isMaleVoiceName("Microsoft Hortense - French (France)")).toBe(false);
    expect(isMaleVoiceName("Microsoft Julie - French (France)")).toBe(false);
  });

  it("only warns when answers would be silent", () => {
    expect(voiceNotice({ state: "ready" }, false)).toBeNull();
    expect(voiceNotice({ state: "loading", percent: 40 }, true)).toBeNull();
    expect(voiceNotice({ state: "failed" }, true)).toBeNull();
    expect(voiceNotice({ state: "loading", percent: 40 }, false)).toEqual({ kind: "loading", percent: 40 });
    expect(voiceNotice({ state: "idle" }, false)).toEqual({ kind: "loading", percent: 0 });
    expect(voiceNotice({ state: "failed" }, false)).toEqual({ kind: "none" });
  });

  it("has a Piper voice for every language", () => {
    for (const lang of LANGS) expect(PIPER_VOICES[lang]).toMatch(/^[a-z]{2}_[A-Z]{2}-/);
  });
});

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
