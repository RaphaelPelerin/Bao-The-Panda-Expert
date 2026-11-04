import type { AskEvent, AskRequest } from "../../shared/protocol";

/**
 * POSTs a question and calls onEvent for each server-sent event as it arrives.
 * The Model Studio key stays on the server (Vercel / .env); the browser never sends it.
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
  if (response.status === 503) {
    throw new Error("missing-key");
  }
  if (!response.ok || !response.body) {
    throw new Error(`Server answered ${response.status}`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let finished = false;
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
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6)) as AskEvent;
          if (event.type === "done" || event.type === "error") finished = true;
          onEvent(event);
        }
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  }
  // A reply cut short (crashed or killed function) must not leave the panda thinking forever.
  if (!finished && !signal.aborted) throw new Error("The answer stream ended early");
}
