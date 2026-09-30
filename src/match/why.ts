/** The most a trimmed profile note may run, before an ellipsis. */
const NOTE_MAX = 200;
/** The most a quoted session sentence may run, not counting its ellipses. */
const QUOTE_MAX = 160;
/** The profiling guide's own prefix for a gap note; it says nothing the pattern name does not. */
const NOTE_BOILERPLATE = /^not evident in the cited scope:\s*/i;
/** A sentence ends at ".", "!" or "?" followed by whitespace and something that starts a sentence;
 * a lowercase word after a period ("e.g. the") or a file extension ("cdk-construct.ts,") does not end one. */
const SENTENCE_END = /[.!?](?=\s+[A-Z0-9"'“(\[])/;
const BOUNDARY = /[.!?]["')\]”]?(?=\s+[A-Z0-9"'“(\[])|\n+/g;

function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const space = head.lastIndexOf(" ");
  return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** One sentence of a profile note, at most about 200 characters, without the profiling-guide
 * boilerplate prefix or a trailing period. `undefined` when nothing is left. */
export function trimNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const flat = note.replace(/\s+/g, " ").trim().replace(NOTE_BOILERPLATE, "");
  const end = flat.search(SENTENCE_END);
  const sentence = (end === -1 ? flat : flat.slice(0, end + 1)).replace(/[.!?]+$/, "").trim();
  return sentence === "" ? undefined : cutAtWord(sentence, NOTE_MAX);
}

function sentenceBounds(text: string, index: number, length: number): { start: number; end: number } {
  let start = 0;
  let end = text.length;
  for (const boundary of text.matchAll(BOUNDARY)) {
    const boundaryEnd = boundary.index + boundary[0].length;
    if (boundaryEnd <= index) {
      start = boundaryEnd;
    } else if (boundary.index >= index + length) {
      end = boundary[0].startsWith("\n") ? boundary.index : boundaryEnd;
      break;
    }
  }
  return { start, end };
}

/** The sentence of `text` that holds the match at `index`, trimmed to about 160 characters around
 * the match with ellipses. Always a verbatim slice of `text` apart from those ellipses. */
export function quoteAround(text: string, index: number, length: number): string {
  const { start, end } = sentenceBounds(text, index, length);
  if (end - start <= QUOTE_MAX) return text.slice(start, end).trim();
  let from = Math.max(start, index - Math.max(0, Math.floor((QUOTE_MAX - length) / 2)));
  const to = Math.min(end, from + QUOTE_MAX);
  from = Math.max(start, to - QUOTE_MAX);
  // Snap inward to word boundaries, never past the match itself.
  const wordStart = from > start && text[from - 1] !== " " ? Math.min(text.indexOf(" ", from) + 1, index) : from;
  const lastSpace = text.lastIndexOf(" ", to);
  const wordEnd = to < end && text[to] !== " " && lastSpace >= index + length ? lastSpace : to;
  const quote = text.slice(wordStart, wordEnd).trim();
  return `${wordStart > start ? "…" : ""}${quote}${wordEnd < end ? "…" : ""}`;
}
