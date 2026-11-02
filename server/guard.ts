import { TAG_IN, TAG_OUT } from "./prompt";

export type Verdict = "in" | "out";

export interface GuardedStream {
  verdict: Verdict;
  /** The answer text that follows the tag. Empty when the verdict is "out". */
  rest: AsyncGenerator<string>;
}

const LONGEST_TAG = Math.max(TAG_IN.length, TAG_OUT.length);

/**
 * Reads the leading [IN]/[OUT] tag from a model text stream before anything is
 * forwarded. Fails closed: a missing or malformed tag counts as out of scope,
 * so a model that ignores the format can never leak an unchecked answer.
 */
export async function readVerdict(source: AsyncIterable<string>): Promise<GuardedStream> {
  const iterator = source[Symbol.asyncIterator]();
  let head = "";

  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    head += next.value;

    const trimmed = head.trimStart();
    if (trimmed.startsWith(TAG_OUT)) {
      await iterator.return?.();
      return { verdict: "out", rest: empty() };
    }
    if (trimmed.startsWith(TAG_IN)) {
      const remainder = trimmed.slice(TAG_IN.length).trimStart();
      return { verdict: "in", rest: continueWith(remainder, iterator) };
    }
    if (trimmed.length >= LONGEST_TAG) break;
  }

  await iterator.return?.();
  return { verdict: "out", rest: empty() };
}

async function* continueWith(first: string, iterator: AsyncIterator<string>): AsyncGenerator<string> {
  // The text right after the tag may still start with spaces in the next chunk.
  let leading = true;
  let pending = first;
  while (true) {
    if (leading) pending = pending.trimStart();
    if (pending) {
      leading = false;
      yield pending;
    }
    const next = await iterator.next();
    if (next.done) return;
    pending = next.value;
  }
}

async function* empty(): AsyncGenerator<string> {}
