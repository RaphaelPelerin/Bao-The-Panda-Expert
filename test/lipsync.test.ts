import { afterEach, describe, expect, it, vi } from "vitest";
import { lipSync } from "../src/avatar/lipsync";
import { tokenize, wordVisemes } from "../src/avatar/visemes";

describe("wordVisemes", () => {
  it("closes the lips on m, b and p", () => {
    expect(wordVisemes("bamboo", "en")).toEqual(["PP", "aa", "PP", "U"]);
  });

  it("reads English digraphs and silent final e", () => {
    expect(wordVisemes("the", "en")).toEqual(["TH", "E"]);
    expect(wordVisemes("shoe", "en")).toEqual(["CH", "O"]);
    expect(wordVisemes("make", "en")).toEqual(["PP", "aa", "kk"]);
  });

  it("reads French vowel groups and silent endings", () => {
    expect(wordVisemes("beaucoup", "fr")).toEqual(["PP", "O", "kk", "U"]);
    expect(wordVisemes("mangent", "fr")).toEqual(["PP", "aa", "CH"]);
    expect(wordVisemes("le", "fr")).toEqual(["DD", "ah"]);
    expect(wordVisemes("pandas", "fr")).toEqual(["PP", "aa", "DD", "aa"]);
  });

  it("never returns an empty word", () => {
    expect(wordVisemes("h", "fr").length).toBeGreaterThan(0);
  });
});

describe("tokenize", () => {
  it("keeps the character index of every word for boundary events", () => {
    const tokens = tokenize("Hi, panda fans!", "en");
    expect(tokens.filter((t) => !t.pause).map((t) => t.charIndex)).toEqual([0, 4, 10]);
    expect(tokens.filter((t) => t.pause)).toHaveLength(2);
  });
});

describe("lipSync", () => {
  afterEach(() => {
    lipSync.stop();
    vi.useRealTimers();
  });

  it("opens the mouth on vowels and rests when stopped", () => {
    vi.useFakeTimers();
    lipSync.start("ah", "en", 1, 1000);
    vi.advanceTimersByTime(300);
    expect(lipSync.sample(performance.now()).open).toBeGreaterThan(0.5);
    lipSync.stop();
    vi.advanceTimersByTime(500);
    expect(lipSync.sample(performance.now())).toMatchObject({ open: 0, active: 0 });
  });

  it("jumps to the word the voice is actually saying", () => {
    vi.useFakeTimers();
    lipSync.start("mmm aaa", "en", 1, 10_000);
    // Still early in "mmm" by the estimate, but the voice says "aaa" now.
    lipSync.boundary(4);
    vi.advanceTimersByTime(30);
    expect(lipSync.sample(performance.now()).open).toBeGreaterThan(0.5);
  });
});
