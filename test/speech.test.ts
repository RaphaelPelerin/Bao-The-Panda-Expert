import { describe, expect, it } from "vitest";
import { audioFromEventLine, MAX_TTS_CHARS, parseTtsRequest, speechBody } from "../server/tts";
import { isCloudVoice } from "../src/voice/tts";
import { decodePcm, isMaleVoiceName } from "../src/voice/voiceStatus";
import { prepareAudio, resample } from "../src/voice/wav";

describe("voice selection", () => {
  it("recognizes male local voices by name", () => {
    expect(isMaleVoiceName("Microsoft Paul - French (France)")).toBe(true);
    expect(isMaleVoiceName("Microsoft David - English (United States)")).toBe(true);
    expect(isMaleVoiceName("Microsoft Hortense - French (France)")).toBe(false);
    expect(isMaleVoiceName("Microsoft Julie - French (France)")).toBe(false);
  });

  it("decodes PCM and keeps a byte split across chunks", () => {
    const { samples, leftover } = decodePcm(new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0x7f]));
    expect([...samples]).toEqual([0.5, -0.5]);
    expect([...leftover]).toEqual([0x7f]);
  });
});

describe("speech route", () => {
  it("validates requests and caps their length", () => {
    expect(parseTtsRequest(JSON.stringify({ text: " Hi ", lang: "fr" }))).toEqual({ text: "Hi", lang: "fr" });
    expect(parseTtsRequest(JSON.stringify({ text: "Hi", lang: "xx" })).lang).toBe("en");
    expect(() => parseTtsRequest(JSON.stringify({ text: " " }))).toThrow();
    expect(() => parseTtsRequest(JSON.stringify({ text: "x".repeat(MAX_TTS_CHARS + 1) }))).toThrow();
  });

  it("asks for the panda voice in the right language", () => {
    const { input } = speechBody("Bonjour", "fr");
    expect(input.voice).toBe("xunanchuan_v3.1");
    expect(input.language_hints).toEqual(["fr"]);
    expect(input.instruction).toContain("panda");
    expect(input.format).toBe("pcm");
  });

  it("reads audio from the provider's events and surfaces its errors", () => {
    const audio = Buffer.from([1, 2, 3]).toString("base64");
    expect([...audioFromEventLine(`data:{"output":{"audio":{"data":"${audio}"}}}`)!]).toEqual([1, 2, 3]);
    expect(audioFromEventLine("event:result")).toBeNull();
    expect(audioFromEventLine(`data:{"output":{"audio":{"data":""}}}`)).toBeNull();
    expect(() => audioFromEventLine(`data:{"code":"Throttling","message":"slow down"}`)).toThrow("Throttling");
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
