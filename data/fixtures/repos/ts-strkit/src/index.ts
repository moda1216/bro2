/** Small string utilities. */

/** Turn arbitrary text into a url-safe slug. */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Shorten `text` to at most `max` characters, appending "..." when cut.
 * Contract: the returned string never exceeds `max`.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

/** Split text into lines. Handles both LF and CRLF input. */
export function splitLines(text: string): string[] {
  return text.split("\n");
}

/** Count words, ignoring runs of whitespace. */
export function wordCount(text: string): number {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return parts.length;
}
