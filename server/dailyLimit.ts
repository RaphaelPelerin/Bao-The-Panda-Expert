import { readFileSync, writeFileSync } from "node:fs";

interface Usage {
  date: string;
  count: number;
}

/**
 * Counts the questions sent to the LLM per local day, saved to a file so a
 * server restart doesn't reset it. A max of 0 means no limit.
 */
export class DailyLimit {
  constructor(
    readonly max: number,
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Uses one question; false once today's limit is reached. */
  take(): boolean {
    const usage = this.read();
    if (this.max > 0 && usage.count >= this.max) return false;
    usage.count++;
    writeFileSync(this.file, JSON.stringify(usage));
    return true;
  }

  /** Questions used today. */
  get used(): number {
    return this.read().count;
  }

  private read(): Usage {
    const date = localDate(this.now());
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Usage>;
      if (data.date === date && Number.isInteger(data.count)) return { date, count: data.count! };
    } catch {
      // No file yet, or unreadable: start the day at zero.
    }
    return { date, count: 0 };
  }
}

export class DailyLimitReached extends Error {
  constructor(max: number) {
    super(`Daily limit of ${max} questions reached; answering offline until tomorrow.`);
  }
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
