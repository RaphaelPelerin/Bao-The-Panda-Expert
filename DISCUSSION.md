# Technical discussion

Answers to the follow-up questions, tied to the code where the current version already lays the groundwork.

## Q1. Lip synchronization

**Today**: Bao's voice is PCM audio streamed from Alibaba's TTS (`server/tts.ts`) and played through Web Audio. That API returns audio but no timing, so the app builds its own:

- `src/avatar/visemes.ts` turns each sentence into mouth shapes, with rules per language.
- `src/avatar/lipsync.ts` lays them on a timeline, then stretches it to the sentence's exact audio length once all of its audio has arrived.
- The panda shader pastes real mouths cut from the talk clip (`public/lipsync/`, built by `npm run lipsync`) at the position the mouth has on the current video frame.

It reads as speech, but it isn't exact: the pace inside a sentence is estimated, and the timeline runs on `performance.now()`, not the audio clock.

To tighten it, there are three levels:

1. **Amplitude (cheap, robust).** Read the RMS level of the playing audio with an `AnalyserNode` (the same code as `MicLevel`) and use it to scale the mouth's opening, so pauses and loud syllables match the sound.
2. **Visemes from the TTS (accurate).** Use a provider that returns phoneme or viseme timestamps:
   - Azure gives viseme events.
   - Polly gives speech marks.
   - ElevenLabs gives character alignment, which a grapheme-to-phoneme step converts to visemes.

   Then schedule the existing mouth shapes against `AudioContext.currentTime`, not wall-clock time, so they can't drift.
3. **Generative (best looking, highest latency).** Run the audio and the avatar video through a lip-sync model (Sync Labs, Hedra, MuseTalk). It isn't real-time today unless you stream short chunks from a GPU server.

In all three cases audio becomes the master clock, and the avatar reads its position every frame.

## Q2. Real-time latency (4 seconds is too slow)

**Measure first.** The latency panel (press D) timestamps each step from the moment the question is final: topic verdict, first text, first audio, answer complete. The server also logs time-to-verdict and total time per request. The panel starts after transcription, so my first change would be adding marks for end of speech and end of transcription; otherwise the likely bottleneck stays invisible.

Here is where the time goes in this app. The measurements come from a few one-off tests on one PC, so they show the order of magnitude, not a benchmark:

| Step | In this app | How to reduce it |
|---|---|---|
| End-of-speech detection | 0.9 s of silence (`SILENCE_MS` in `src/voice/stt.ts`) | Lower the threshold, or use a proper voice activity detector (VAD) so it can be shorter without cutting people off. |
| Speech-to-text | About 3–6 s for 2–3 s of audio with Whisper tiny on the CPU, measured in a background window, so possibly pessimistic. **The likely bottleneck.** | Use WebGPU where available and move Whisper to a Web Worker, which also stops it freezing the avatar. For a large gain, use a streaming STT service (Deepgram, AssemblyAI) with partials, at the cost of a paid API and a third-party dependency. |
| Model answer | About 1.5 s for a whole short answer in one live test | A fast model with thinking off (as today), a short prompt, and prompt caching once the prompt is long enough. |
| Waiting for the full answer | None | Already solved: sentences go to TTS as they arrive. |
| TTS time-to-first-audio | About 0.4 s from my machine, 1.7 s on one live request | Keep the first sentence short (the chunker already cuts long ones at a comma) and keep the function warm. |

Perceived latency matters as much as real latency. The panda switches to "thinking" right away and shows the question as a caption. A short filler line such as "Hmm, good question…" could also play from a cached clip while the model starts.

## Q3. Streaming responses

The current version already speaks before the model finishes:

1. The server streams Qwen's text deltas over SSE (`server/ask.ts`). The only buffering is the few characters of the `[IN]`/`[OUT]` tag.
2. `SentenceChunker` (`src/llm/sentences.ts`) emits each complete sentence, and long ones at a comma.
3. `SpeechOutput` (`src/voice/tts.ts`) keeps a queue: sentence 1 plays while sentences 2 and 3 are still being generated. `finish()` marks the end so the state machine leaves "speaking" only after the last sentence.

The TTS streams too. Each sentence goes to `/api/tts` as soon as it's chunked, so sentence n+1 is already being fetched while sentence n plays. Its PCM chunks are scheduled back to back with Web Audio as they arrive, so playback starts before a sentence's audio has fully arrived.

## Q4. Interruption handling

**Today**: pressing the mic (or Space, or Esc) while Bao is thinking or talking calls `interrupt()`:

- the `fetch` is aborted, and the server sees the closed connection and aborts the Qwen stream, so tokens stop being generated and billed;
- the speech queue and any pending TTS requests are cancelled, and the panda stops talking.

The user then presses the mic again to ask something else. The reducer accepts `LISTEN` from any state, and every async callback checks its `AbortController` or its TTS generation number, so a late chunk from the old answer can't leak into the new one.

**Hands-free barge-in** isn't built yet, and it adds one problem: the microphone hears the panda.

- Keep the mic open while speaking, with `echoCancellation: true` (already set in `MicLevel`), and play TTS through the same audio context so the browser's echo canceller has a reference.
- Run a VAD and require a few hundred milliseconds of speech above a threshold before treating it as an interruption, so coughs and short noises don't trigger it.
- On barge-in, fade the voice out over about 150 ms rather than cutting it, switch to "listening", and save what the panda had already said as a partial assistant turn in the history. That way the model knows where it was cut off.

## Q5. Topic restriction

Defense in depth, from cheapest to most robust:

1. **Structured verdict, enforced by the server.** The model must start with `[IN]` or `[OUT]`, and `readVerdict` (`server/guard.ts`) checks it before forwarding a single word. `[OUT]` or a malformed reply plays a fixed refusal from the code. The model never writes the refusal and can't be talked into an off-topic answer that slips through.
2. **A precise scope in the prompt** (`server/prompt.ts`):
   - giant and red pandas count;
   - follow-ups that refer to earlier panda talk count;
   - mixed questions get only the panda part, plus a one-line scope note;
   - "pandas" as a thin wrapper for an unrelated task is out, for example "write Python code about pandas" or the pandas DataFrame library;
   - requests to change the rules or reveal the prompt are out.
3. **Untrusted input stays in the user turn.** The browser's history is validated on the server: roles are checked, the length is capped, and it must start with a user turn. The client can't inject system text.
4. **A regression suite.** `npm run eval` runs 17 cases against the live model: the challenge's examples, ambiguous ones (red pandas, pandas vs polar bears), mixed ones, the pandas library, prompt injection, and French.

For production, I'd add:

- A separate cheap classifier call (a small model with structured output) run in parallel with generation, with a cancel if it disagrees. The extra latency is hidden.
- Logging of verdicts and user-reported misses, which grows the eval set.

Ambiguous cases ("tell me about bears") are best handled by answering the panda angle ("pandas are bears, actually…"). That's friendlier than refusing, and the prompt already pushes in that direction.

## Q6. Video-based avatar

This is how the avatar works today: three short AI-generated clips (`public/videos/`) for idle, thinking and talking, drawn on the same plane in a WebGL shader. The state machine didn't need to change, only the avatar's texture source.

**Making each clip loop**

- Generated clips never quite end where they started, so `scripts/make-loop.ts` bakes the loop into the file. It skips the opening frames, whose color grade is off, and finds where the end can join the start.
- The idle clip uses a quarter-second cross-fade at a join where the eyes are open on both sides, so a blink never blends into a double image.
- The talk and think clips play forward then backward, because the head never returns to the same place and a cross-faded join would ghost.
- Each clip plays on one `<video>` with the browser's native loop, so playback never seeks or freezes at the wrap.

**Transparency**

The clips are shot on a blue screen, and the shader keys it out and removes the blue that bleeds into the fur. It's simple and runs in every browser, including Safari, which can't play WebM with alpha.

**Transitions**

- All three clips keep playing from the moment they load, so each texture is live before its state starts.
- Transitions are cross-faded in the shader over 0.25 s (two textures and a `mix` uniform) rather than with CSS opacity. That keeps a single composited layer and avoids black frames during the switch.
- Idle ↔ talk switches only when the eyes stay open on both clips for the whole fade, using eye tracks stored in `public/lipsync/mouths.json`, so a blink never cross-fades into open eyes. If the hidden clip is mid-blink, it's moved to the next frames where the eyes are open. Think has no eye track, so its fade isn't gated.
- `requestVideoFrameCallback` reports which frame is really on screen, so the pasted mouth follows the head exactly.
- The loading screen waits for every clip to buffer, so none of them first appears half-loaded. If the video can't load, the avatar falls back to the still portrait.

**What I'd improve next**

- Generate every clip from the same neutral keyframe as both first and last frame, so any clip can follow any other with less blending.
- Use a matting model (RobustVideoMatting, BiRefNet) with stacked alpha (color and alpha in one H.264 video) if the fur edges need softer alpha than a chroma key gives.
- Add a dedicated refusal clip. Today a refusal uses the talk clip plus a small head shake.
