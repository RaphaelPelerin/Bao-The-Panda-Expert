import Anthropic from "@anthropic-ai/sdk";
import type { AskRequest } from "../../shared/protocol";
import { LANGUAGE_HINT, SYSTEM_PROMPT, TAG_OUT } from "../prompt";

const MODEL = process.env.PANDA_MODEL || "claude-opus-5-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  // Credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
  client ??= new Anthropic({ maxRetries: 1, timeout: 20_000 });
  return client;
}

/**
 * Streams the raw model text (tag included) for one question. The caller runs
 * it through the topic guard before anything reaches the user.
 */
export async function* streamClaude(req: AskRequest, signal: AbortSignal): AsyncGenerator<string> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...req.history.map((turn) => ({ role: turn.role, content: turn.text })),
    { role: "user", content: req.question },
  ];

  const stream = getClient().beta.messages.stream(
    {
      model: MODEL,
      // Room for adaptive thinking plus a short spoken answer.
      max_tokens: 4000,
      output_config: { effort: "low" },
      system: [
        { type: "text", text: SYSTEM_PROMPT },
        { type: "text", text: LANGUAGE_HINT[req.lang] },
      ],
      messages,
      // On a safety decline the API retries on a fallback model inside the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    },
    { signal },
  );

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }

  const final = await stream.finalMessage();
  // A refusal that produced no text yet reads as out of scope, so the app plays its refusal line.
  if (final.stop_reason === "refusal" && !final.content.some((b) => b.type === "text" && b.text)) {
    yield TAG_OUT;
  }
}

export function isClaudeUnavailable(error: unknown): boolean {
  return (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError ||
    error instanceof Anthropic.APIConnectionError ||
    // Client-side setup errors, such as no credentials configured at all.
    (error instanceof Anthropic.AnthropicError && !(error instanceof Anthropic.APIError))
  );
}
