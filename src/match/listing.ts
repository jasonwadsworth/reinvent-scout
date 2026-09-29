/**
 * Enumerations of names ("Lambda, Amazon EC2, ECS and EKS"). A session that names a service only
 * inside such a list mentions it in passing, next to every other service in the list; that is not
 * a signal about the service. An item is one word, or up to four capitalized words (a service or
 * product name); a listing is three or more items separated by commas, "and", "or" or slashes.
 */
const WORD = "[A-Za-z0-9][\\w.+&'-]*";
const NAME_WORD = "[A-Z0-9][\\w.+&'-]*";
const ITEM = `(?!(?:and|or)\\b)(?:${NAME_WORD}(?: ${NAME_WORD}){0,3}|${WORD})`;
const SEPARATOR = "(?:,? (?:and|or) |, ?|/)";
const LISTING = new RegExp(`${ITEM}(?:${SEPARATOR}${ITEM}){2,}`, "g");

function listingSpans(text: string): Array<[number, number]> {
  return [...text.matchAll(LISTING)].map(match => [match.index, match.index + match[0].length]);
}

/** The matches of `pattern` in `text` that do not sit inside an enumeration of three or more names. */
export function unlistedMatches(pattern: RegExp, text: string): RegExpExecArray[] {
  const spans = listingSpans(text);
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return [...text.matchAll(global)].filter(match =>
    !spans.some(([start, end]) => match.index >= start && match.index + match[0].length <= end));
}
