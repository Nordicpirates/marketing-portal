import { existsSync, readFileSync } from "fs";

// Every object line of a JSONL file, in order; a missing file is empty, an unreadable one
// throws, a bad line is counted and never logged. docs/JSONL-STORES.md
export function readJsonlObjects(
  file: string,
  tag: string,
  label: string
): { objects: Record<string, unknown>[]; malformed: number } {
  if (!existsSync(file)) return { objects: [], malformed: 0 };

  const lines = readFileSync(file, "utf8").split("\n");
  const objects: Record<string, unknown>[] = [];
  let malformed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed++;
      console.error(
        `[${tag}] ${label} line ${i + 1} is not valid JSON and was skipped. ` +
          `The line is not logged: it can hold an email address. Open ${file} to see it.`
      );
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      malformed++;
      console.error(
        `[${tag}] ${label} line ${i + 1} is valid JSON but not an object, so it was skipped. ` +
          `Open ${file} to see it.`
      );
      continue;
    }

    objects.push(parsed as Record<string, unknown>);
  }

  return { objects, malformed };
}
