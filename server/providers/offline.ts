import type { AskRequest } from "../../shared/protocol";
import { TAG_IN, TAG_OUT } from "../prompt";
import { answerOffline } from "./knowledge";

const WORD_DELAY_MS = 18;

/**
 * Same contract as streamQwen: yields tagged text in small chunks, so the
 * guard, the SSE route and the client streaming path are exercised identically.
 */
export async function* streamOffline(req: AskRequest, signal: AbortSignal): AsyncGenerator<string> {
  const result = answerOffline(req.question, req.lang, req.history);
  if (!result.inScope || !result.text) {
    yield TAG_OUT;
    return;
  }

  yield `${TAG_IN} `;
  for (const word of result.text.split(/(?<=\s)/)) {
    if (signal.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, WORD_DELAY_MS));
    yield word;
  }
}
