// Splits streamed text into speakable pieces so text-to-speech can start on
// the first sentence while the rest of the answer is still being generated.

const SENTENCE_END = /[.!?…]+["')\]]*\s+/g;
/** Past this length, cut at the last comma rather than keep the voice waiting. */
const SOFT_LIMIT = 160;

export class SentenceChunker {
  private buffer = "";

  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];

    let cut = 0;
    for (const match of this.buffer.matchAll(SENTENCE_END)) {
      const end = match.index + match[0].length;
      const sentence = this.buffer.slice(cut, end).trim();
      if (sentence) out.push(sentence);
      cut = end;
    }
    this.buffer = this.buffer.slice(cut);

    if (this.buffer.length > SOFT_LIMIT) {
      const comma = this.buffer.lastIndexOf(", ");
      if (comma > 40) {
        out.push(this.buffer.slice(0, comma + 1).trim());
        this.buffer = this.buffer.slice(comma + 2);
      }
    }
    return out;
  }

  /** Returns whatever is left once the stream has ended. */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }
}
