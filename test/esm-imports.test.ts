import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Vercel runs the api/ function with plain Node ESM, which needs full file paths.
// Vite and tsx resolve extensionless imports, so only production would crash.

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("server imports", () => {
  it("use explicit .js extensions, as Node ESM requires on Vercel", () => {
    const offenders = ["api", "server", "shared"].flatMap(sourceFiles).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/from "(\.\.?\/[^"]+)"/g)]
        .map((match) => match[1])
        .filter((specifier) => !specifier.endsWith(".js"))
        .map((specifier) => `${file}: ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });
});
