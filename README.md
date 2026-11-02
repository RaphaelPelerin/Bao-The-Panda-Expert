# Bao, the voice-interactive panda

Bao is a panda avatar standing in a living bamboo forest. You ask questions out loud and Bao answers out loud, but only about pandas. Anything else gets a polite refusal.

- **Voice in**: Web Speech API recognition, with live captions while you speak.
- **Answers**: Qwen Flash by default (fast and cheap, thinking off), or any OpenAI-compatible LLM, or Claude, streamed. A server-side guard rejects off-topic questions before any text leaves the server.
- **Voice out**: browser text-to-speech that starts on the first sentence while the rest of the answer is still being written.
- **Avatar**: five visible states (idle, listening, thinking, speaking, refusing) driven by one state machine and rendered in a real-time three.js scene: bamboo and leaves bending in shared wind gusts, light shafts, pollen, falling leaves.
- **Always works**: no API key, no network or no microphone still gives a full demo. The server falls back to a built-in panda knowledge base, and a text field replaces the mic.

## Quick start

Requires Node 20 or newer and a Chromium-based browser (Chrome or Edge) for voice input. Safari also works; Firefox falls back to typing.

```bash
npm install
cp .env.example .env    # optional: add LLM_API_KEY (Alibaba Cloud Model Studio key for Qwen)
npm run dev             # http://localhost:5173
```

Without a key, Bao answers from the offline knowledge base. The latency panel (press **D**) shows which provider answered.

### Choosing a model

| Provider | `.env` | Notes |
|---|---|---|
| Qwen (Alibaba Cloud Model Studio) | `LLM_API_KEY=…` (`LLM_PROVIDER=qwen-intl` is the default; use `qwen` for a mainland China account) | Default. Model `qwen-flash` with thinking turned off: short factual answers don't need reasoning, so it answers straight away. Cheap, and new accounts usually get a free quota. |
| DeepSeek | `LLM_PROVIDER=deepseek`, `LLM_API_KEY=…` | Model `deepseek-chat` (non-reasoning mode). Paid balance. |
| Any other OpenAI-compatible API (Kimi, GLM, Groq…) | `LLM_PROVIDER=<name>`, `LLM_BASE_URL=…`, `LLM_MODEL=…`, `LLM_API_KEY=…` | |
| Claude | `ANTHROPIC_API_KEY=…` | Used when no `LLM_API_KEY` is set. Not available in mainland China. |

Model names change often: check the provider's console and override with `LLM_MODEL` if needed. In `auto` mode, a provider with a bad key or no network is skipped, and an exhausted quota falls back to the next provider for that question. The panda never goes silent.

Only the server calls the LLM, so the region to pick is where the server runs and where the account was created, not where visitors are. Also note that Chrome's speech recognition relies on Google servers, which are blocked there; the text input still works.

| Command | What it does |
|---|---|
| `npm run dev` | Front end and `/api/ask` in one Vite process, with hot reload for both |
| `npm test` | Unit tests: topic guard, providers (against a mock OpenAI-compatible server), offline expert, state machine, sentence splitter, request validation |
| `npm run eval` | Runs 17 in-scope, out-of-scope and adversarial questions against the live model and checks every verdict (needs a key) |
| `npm run build && npm start` | Production build served by a small Node server on port 8787 |

### Controls

- **Mic button** or **Space**: start talking. Recognition stops by itself when you pause.
- Pressing again while Bao is thinking or talking **interrupts** it.
- **Esc**: stop everything.
- **Keyboard button**: type instead of speaking.
- **EN / FR**: language for recognition, answers and voice.
- **D**: latency panel.

## Architecture

```
Browser                                                 Node (Vite dev middleware or server/index.ts)
───────────────────────────────────────────────         ──────────────────────────────────────────────
SpeechInput (STT) ─ final transcript ─┐
MicLevel (Web Audio) ─ loudness ──────┼──▶ signals      POST /api/ask  { question, lang, history }
                                      │    (per frame)        │
useConversation (orchestrator) ◀──────┘                       ▼
   │  dispatches events                                 provider stream ("[IN] Pandas eat…")
   ▼                                                          │   Qwen Flash → Claude → offline
reduce() state machine                                        ▼
   idle → listening → thinking → speaking → idle        readVerdict(): reads the tag first, fails closed
   │                                                          │
   ├── askStream() ◀── SSE: verdict, delta…, done ◀───────────┘   out of scope → fixed refusal text
   │      └─▶ SentenceChunker ─▶ SpeechOutput (TTS queue) ─▶ signals.speaking / word boundaries
   ▼
React UI (captions, mic, status)      three.js scene reads `signals` every frame (no re-renders)
```

### Main choices

**One state machine for everything.** `src/state/machine.ts` is a pure reducer with five states and ten events. The UI, the avatar pose and the scene effects are derived from its `status`, and impossible transitions are ignored. Side effects (microphone, fetch, speech) live in a single hook, `useConversation`. The reducer is tested without a browser.

**The topic restriction is enforced in code, not only in the prompt.** The model must start every reply with `[IN]` or `[OUT]`. The server reads that tag before forwarding anything:
- `[OUT]` stops generation and sends a refusal written in the code.
- A missing or malformed tag counts as `[OUT]`, so the guard fails closed.

Off-topic questions therefore never reach the user as text, and the refusal wording can't drift. Mixed questions get the panda part answered plus one sentence about scope. The prompt also covers the classic traps: prompt injection, role-play, and "pandas" the Python library. More in [DISCUSSION.md](DISCUSSION.md#q5-topic-restriction).

**Streaming end to end.** The model streams to the server, the server streams to the browser over server-sent events (SSE), and the browser splits the text into sentences and queues them for speech. Bao starts talking after the first sentence instead of after the whole answer. The latency panel shows each step.

**The voice drives the scene, through a mutable `signals` object, not React state.**
- Microphone loudness makes the wind pick up and the pollen glow while you talk.
- In the thinking state, motes gather around Bao's head.
- Speech word boundaries move the jaw.
- A refusal starts with a small head shake.

Keeping these values outside React lets them update 60 times a second without re-rendering the UI.

**The avatar today: the provided image, cut out in the browser.** `src/avatar/cutout.ts` does the cutout:
- It flood-fills the studio background from the image border, using color distance plus a tint check so cream fur isn't mistaken for the pale green backdrop.
- It feathers the edge and removes the background color that bleeds into the fur.

A shader then animates the portrait: breathing, head tilt on the neck, nods, and a jaw that opens with speech. It also adds a warm rim light so the character sits inside the forest's lighting.

The plan is to replace this with AI-generated video clips per state; the transition approach is in [DISCUSSION.md](DISCUSSION.md#q6-video-based-avatar).

**Fallbacks everywhere.**

| If this is missing | What happens |
|---|---|
| API key, quota or network | Next provider in the chain, ending with the offline knowledge base (same streaming contract) |
| `speechSynthesis` | Timed silent playback, so the states still flow |
| Speech recognition | Text input |
| Microphone permission | Clear message, then the app recovers by itself |

### Project layout

```
server/            ask.ts (HTTP + SSE), guard.ts, prompt.ts, index.ts
                   providers/{index,openaiCompatible,claude,offline,knowledge}.ts
shared/protocol.ts request and event types shared by client and server
src/state/         machine.ts, useConversation.ts, metrics.ts
src/voice/         stt.ts, tts.ts, micLevel.ts
src/llm/           askStream.ts (SSE client), sentences.ts
src/avatar/        Panda.tsx (shader), cutout.ts, signals.ts
src/scene/         Scene.tsx, Bamboo.tsx (instanced stalks + leaves, wind shader), Atmosphere.tsx, FallingLeaves.tsx
src/ui/            MicButton, DebugPanel, strings (EN/FR), icons
test/              Vitest suites
scripts/           eval-guard.ts (live verdict check)
```

### Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `LLM_API_KEY` | none | Key for the OpenAI-compatible provider. Enables it. |
| `LLM_PROVIDER` | `qwen-intl` | Preset: `qwen-intl`, `qwen`, `deepseek`, or any name with `LLM_BASE_URL` + `LLM_MODEL` |
| `LLM_BASE_URL`, `LLM_MODEL` | from the preset | Overrides |
| `ANTHROPIC_API_KEY` | none | Claude credentials |
| `PANDA_MODEL` | `claude-opus-5-5` | Claude model. Use `claude-haiku-5-5` for lower latency |
| `PANDA_PROVIDER` | `auto` | `auto` (OpenAI-compatible, then Claude, then offline), `openai`, `claude`, or `offline` |
| `PORT` | `8787` | Port for `npm start` |

Answers are kept short (two to four spoken sentences). OpenAI-compatible requests use a low temperature so the topic tag stays reliable. The Claude request uses low effort. It also enables server-side refusal fallback: if the model's safety system declines, the request is retried on another model inside the same call.

## Known limits

- Browser text-to-speech exposes no audio samples, so the mouth follows word boundaries and a syllable rhythm, not real phonemes. See Q1 in the discussion for real lip sync.
- Voice recognition quality and the available voices depend on the browser and the OS. Edge's "Natural" voices sound best.
- Interruption is push-to-talk: press the mic while Bao talks. Hands-free barge-in needs echo handling (see Q4).
