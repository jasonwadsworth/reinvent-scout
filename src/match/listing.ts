/**
 * Enumerations of names ("Lambda, Amazon EC2, ECS and EKS"). A session that names a service only
 * inside such a list mentions it in passing, next to every other service in the list; that is not
 * a signal about the service. An item is up to four capitalized words (a service or product name,
 * never a lowercase concept word: "DLQs, retries, and idempotency" is not a list of names); a
 * listing is three or more items separated by commas, "and", "or" or slashes.
 */
const NAME_WORD = "[A-Z0-9][\\w.+&'-]*";
const ITEM = `(?!(?:And|Or)\\b)${NAME_WORD}(?: ${NAME_WORD}){0,3}`;
const SEPARATOR = "(?:,? (?:and|or) |, ?|/)";
const LISTING = new RegExp(`${ITEM}(?:${SEPARATOR}${ITEM}){2,}`, "g");

function listingSpans(text: string): Array<[number, number]> {
  return [...text.matchAll(LISTING)].map(match => [match.index, match.index + match[0].length]);
}

/** Capitalizes each match of `vocabulary`, keeping every index, so a list of the caller's own
 * lowercase terms ("containers, serverless, and Lambda") reads as names. */
function nameVocabulary(text: string, vocabulary: RegExp): string {
  const global = new RegExp(vocabulary.source, vocabulary.flags.includes("g") ? vocabulary.flags : `${vocabulary.flags}g`);
  return text.replace(global, match => match.charAt(0).toUpperCase() + match.slice(1));
}

function partitionMatches(pattern: RegExp, text: string, vocabulary?: RegExp): { listed: RegExpExecArray[]; unlisted: RegExpExecArray[] } {
  const spans = listingSpans(vocabulary === undefined ? text : nameVocabulary(text, vocabulary));
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const all = [...text.matchAll(global)];
  const inside = (match: RegExpExecArray): boolean =>
    spans.some(([start, end]) => match.index >= start && match.index + match[0].length <= end);
  return { listed: all.filter(inside), unlisted: all.filter(match => !inside(match)) };
}

/** The matches of `pattern` in `text` that do not sit inside an enumeration of three or more names.
 * `vocabulary` names lowercase terms that count as names too, for a caller whose own terms are
 * ordinary words; without it a lowercase concept list is not an enumeration of names. */
export function unlistedMatches(pattern: RegExp, text: string, vocabulary?: RegExp): RegExpExecArray[] {
  return partitionMatches(pattern, text, vocabulary).unlisted;
}

/** Whether `text` names `pattern` only inside enumerations: at least one match, none outside. */
export function onlyListed(pattern: RegExp, text: string, vocabulary?: RegExp): boolean {
  const { listed, unlisted } = partitionMatches(pattern, text, vocabulary);
  return listed.length > 0 && unlisted.length === 0;
}
