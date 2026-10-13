/**
 * The most stdout one script command may write. Claude Code's Bash tool truncates output over
 * 30,000 characters by default, so the budget stays under that: 24 KiB of raw JSON is about the
 * same content as the old 30 KiB MCP envelope, where every quote of the inner JSON was escaped.
 */
export const OUTPUT_BUDGET_BYTES = 24 * 1024;

export function outputBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function shortenDescription(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max)}…[shortened]` : text;
}
