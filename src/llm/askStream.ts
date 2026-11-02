import type { AskEvent, AskRequest } from "../../shared/protocol";

/**
 * POSTs a question and calls onEvent for each server-sent event as it arrives.
 * Resolves when the stream ends; rejects on network errors (but not on abort).
 */
export async function askStream(
  request: AskRequest,
  onEvent: (event: AskEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Server answered ${response.status}`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)) as AskEvent);
        }
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  }
}
