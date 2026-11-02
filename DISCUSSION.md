# Technical discussion

Answers to the follow-up questions, tied to the code where the current version already lays the groundwork.

## Q1. Lip synchronization

**Today**: `mouthOpenness()` in `src/avatar/signals.ts` combines `SpeechSynthesisUtterance` word-boundary events with a syllable-rate oscillation, and the panda shader opens the jaw by warping the area under the upper lip. It reads as talking, but it isn't synced to sounds.

To sync for real, I'd move synthesis to a TTS API that returns audio and timing, then pick one of three levels:

1. **Amplitude (cheap, robust).** Play the audio through Web Audio, read the RMS level with an `AnalyserNode` (the same code as `MicLevel`), and drive `uMouth` from it. Every TTS provider supports this, and it's already a clear improvement.
2. **Visemes (accurate).** Ask the TTS for phoneme or viseme timestamps:
   - Azure gives viseme events.
   - Polly gives speech marks.
   - ElevenLabs gives character alignment, which a grapheme-to-phoneme step converts to visemes.

   Then schedule the mouth shapes against `AudioContext.currentTime`, not wall-clock time, so they can't drift. With video or sprites that means about 8 to 12 mouth shapes. With a 3D rig it means blendshape weights, blended over roughly 60 ms.
3. **Generative (best looking, highest latency).** Run the audio and the avatar video through a lip-sync model (Sync Labs, Hedra, MuseTalk). It isn't real-time today unless you stream short chunks from a GPU server.

In all three cases audio becomes the master clock, and the avatar reads its position every frame.

## Q2. Real-time latency (4 seconds is too slow)

**Measure first.** The latency panel (press D) already timestamps each step from the moment the question is final: topic verdict, first text, first audio, answer complete. The server also logs time-to-verdict and total time per request. A 4-second delay usually breaks down like this:

| Step | Typical | How to reduce it |
|---|---|---|
| End-of-speech detection | 0.5–1.5 s | Browser STT waits for silence. Use a streaming STT (Deepgram, AssemblyAI, Whisper streaming) with a tuned endpointing threshold (~400 ms), or a voice activity detector (VAD) in the client. |
| Speech-to-text finalization | 0.2–0.6 s | Use the streaming partials and start the request on a confident partial, then confirm or cancel. |
| Model time-to-first-token | 0.3–1.5 s | A smaller model (`PANDA_MODEL=claude-haiku-5-5`), low effort, short prompt, prompt caching once the prompt is long enough, and a warm keep-alive connection. |
| Waiting for the full answer | 1–3 s | Already solved here: sentence streaming into TTS. |
| TTS time-to-first-audio | 0.2–1 s | A streaming TTS (audio chunks over WebSocket), with the first sentence kept short. The chunker already cuts long first sentences at a comma. |

Perceived latency matters as much as real latency. The panda switches to "thinking" right away and shows the question as a caption. A short filler line such as "Hmm, good question…" could also play from a cached clip while the model starts.

## Q3. Streaming responses

The current version already speaks before the model finishes:

1. The server streams Claude's text deltas over SSE (`server/ask.ts`). The only buffering is the few characters of the `[IN]`/`[OUT]` tag.
2. `SentenceChunker` (`src/llm/sentences.ts`) emits each complete sentence, and long ones at a comma.
3. `SpeechOutput` (`src/voice/tts.ts`) keeps a queue: sentence 1 plays while sentences 2 and 3 are still being generated. `finish()` marks the end so the state machine leaves "speaking" only after the last sentence.

With an audio TTS API, the next step is to stream the TTS too: send each sentence as soon as it's chunked, play the returned audio buffers back to back with Web Audio, and pre-fetch sentence n+1 while sentence n plays.

## Q4. Interruption handling

**Today**: pressing the mic (or Space) while Bao is thinking or talking calls `interrupt()`:

- the `fetch` is aborted, and the server sees the closed connection and aborts the Claude stream, so tokens stop being generated and billed;
- the speech queue is reset;
- recognition restarts.

The reducer accepts `LISTEN` from any state, and every async callback checks its `AbortController` or its TTS generation number, so a late chunk from the old answer can't leak into the new one.

**Hands-free barge-in** adds one problem: the microphone hears the panda.

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

Replace the shader portrait with short AI-generated clips per state: idle/listening loop, talking loop, refusal. The scene and the state machine stay the same. Only the avatar's texture source changes.

**Generating clips that connect seamlessly**

- Generate every clip from **the same neutral keyframe as both its first and last frame**. Most image-to-video models (Kling, Veo, MiniMax, Wan) accept a start frame and an end frame.
- Lock the camera and keep a flat, solid background. Every clip then starts and ends on the same pixels, so any clip can follow any other at a loop boundary.
- If one long take is generated instead, cut it at frames where the pose matches the neutral frame. To find those frames automatically, compute the difference between each frame and the reference with ffmpeg plus a small script, and keep the minima.

**Transparency and compositing**

- Remove the background with a matting model rather than a chroma key, because fur edges need soft alpha. RobustVideoMatting or BiRefNet work, or a hosted background-removal tool.
- Export as **stacked alpha**: color in the top half, alpha in the bottom half of a regular H.264 MP4. A WebGL shader recombines them. This works in every browser, including Safari, which can't play WebM with alpha. It also plugs straight into the existing panda plane, so the rim light, fade and shadows still apply.

**Playback without seams**

- Preload every clip in its own `<video>` element (muted, `playsInline`, decoded ahead of time). Each one feeds a `VideoTexture`.
- Switch only at loop boundaries. Talking → idle waits for the current talk loop to end on the neutral frame, so the mouth never snaps shut halfway. An interruption is the one exception: it cross-fades within 120–150 ms, which hides small pose differences.
- Cross-fade in the shader (two textures and a `mix` uniform) instead of with CSS opacity. That keeps a single composited layer, avoids black frames during the switch, and keeps the lighting consistent.
- Use `requestVideoFrameCallback` to know exactly which frame is on screen, and to switch clips on the boundary frame.
- Keep a still neutral frame as the poster texture, so first paint is instant while the videos load.

Lip sync then becomes a choice. A generic talk loop is fine, since the challenge doesn't require exact lip sync. For accuracy, a viseme-indexed sprite set or a generative lip-sync pass applies, as in Q1.
