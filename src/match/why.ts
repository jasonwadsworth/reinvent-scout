import type { Evidence, ResolvedProfile } from "../profile/profile.js";
import type { ConceptMatch } from "./concepts.js";
import { lensRuleDetail, type LensHit } from "./lens-signals.js";

/** Where the profile's code shows the thing a summary names. */
export interface Citation {
  repo: string;
  file: string;
  line?: number;
}

/** Why a session is recommended, built from the profile and the session's own text; never model prose. */
export interface Why {
  summary: string;
  yourCode: Citation[];
  /** How many more places the profile cites than `yourCode` lists; absent when none were cut. */
  more?: number;
  /** A sentence of the session's title or abstract that says it; absent when nothing can be quoted. */
  sessionSays?: string;
}

/** Where a matched phrase sits in a session: its title or abstract, and the offset and length there. */
export interface MatchSite {
  inTitle: boolean;
  index: number;
  length: number;
}

/** The session text a quote can come from. */
export interface SessionText {
  title: string;
  abstract: string;
}

const CITATIONS_LISTED = 3;

/** The most a trimmed profile note may run, before an ellipsis. */
const NOTE_MAX = 200;
/** The most a quoted session sentence may run, not counting its ellipses. */
const QUOTE_MAX = 160;
/** The profiling guide's own prefix for a gap note; it says nothing the pattern name does not. */
const NOTE_BOILERPLATE = /^not evident in the cited scope:\s*/i;
/** A sentence ends at ".", "!" or "?" followed by whitespace and something that starts a sentence;
 * a lowercase word after a period ("e.g. the") or a file extension ("cdk-construct.ts,") does not end one. */
const SENTENCE_END = /(?<!\b(?:e\.g|i\.e|etc|vs|approx))[.!?](?=\s+[A-Z0-9"'“(\[])/;
const BOUNDARY = /(?<!\b(?:e\.g|i\.e|etc|vs|approx))[.!?]["')\]”]?(?=\s+[A-Z0-9"'“(\[])|\n+/g;
/** What a gap note says is missing. A note cut to a clause without it would say what is there instead. */
const NEGATIVE = /\b(?:no|not|without|missing|lacks?|lacking|none|never|absent)\b/i;

/** Cuts at the last clause break (", " or "; ") once past the note's midpoint, else at a word, so a
 * long note ends on a thought rather than on "so a". */
function cutAtClause(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const clause = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "));
  const space = head.lastIndexOf(" ");
  const atWord = space > 0 ? space : max;
  const keepsGap = !NEGATIVE.test(text) || NEGATIVE.test(head.slice(0, Math.max(clause, 0)));
  const cut = clause >= max / 2 && keepsGap ? clause : atWord;
  const kept = head.slice(0, cut);
  // Never end inside an open parenthesis.
  const open = kept.lastIndexOf("(");
  const unclosed = open > kept.lastIndexOf(")") && open > 0;
  return `${(unclosed ? kept.slice(0, open) : kept).trimEnd().replace(/[,;:]$/, "")}…`;
}

/** `text` with every parenthetical aside removed, innermost first, for a note set inside parentheses. */
function withoutParentheses(text: string): string {
  const stripped = text.replace(/\s*\([^()]*\)/g, "");
  return stripped === text ? text : withoutParentheses(stripped);
}

/** One sentence of a profile note, at most about 200 characters, without the profiling-guide
 * boilerplate prefix or a trailing period. `undefined` when nothing is left. */
export function trimNote(note: string | undefined, withoutAsides = false): string | undefined {
  if (note === undefined) return undefined;
  const flat = (withoutAsides ? withoutParentheses(note) : note).replace(/\s+/g, " ").trim().replace(NOTE_BOILERPLATE, "");
  const end = flat.search(SENTENCE_END);
  const sentence = (end === -1 ? flat : flat.slice(0, end + 1)).replace(/[.!?]+$/, "").trim();
  return sentence === "" ? undefined : cutAtClause(sentence, NOTE_MAX);
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
  const cutShort = wordEnd < end;
  const quote = text.slice(wordStart, wordEnd).trim().replace(cutShort ? /[,;:]$/ : /(?!)/, "");
  return `${wordStart > start ? "…" : ""}${quote}${cutShort ? "…" : ""}`;
}

/** Up to three deduped places in profile order, plus how many were left out. */
export function citationsOf(evidence: readonly Evidence[]): Pick<Why, "yourCode" | "more"> {
  const seen = new Set<string>();
  const all: Citation[] = [];
  for (const item of evidence) {
    const key = JSON.stringify([item.repo, item.file, item.line]);
    if (seen.has(key)) continue;
    seen.add(key);
    all.push({ repo: item.repo, file: item.file, ...(item.line === undefined ? {} : { line: item.line }) });
  }
  const more = all.length - CITATIONS_LISTED;
  return { yourCode: all.slice(0, CITATIONS_LISTED), ...(more > 0 ? { more } : {}) };
}

/** The title when the match is in it, else the abstract sentence holding the match. `undefined`
 * when the site does not fall inside the text it claims, so nothing is ever invented. */
export function quoteSite(text: SessionText, site: MatchSite): string | undefined {
  if (site.inTitle) return text.title === "" ? undefined : text.title;
  if (site.index < 0 || site.index + site.length > text.abstract.length) return undefined;
  const quote = quoteAround(text.abstract, site.index, site.length);
  return quote === "" ? undefined : quote;
}

/** One sentence: `body` without its final period, an optional "(+N more)", then the period. */
function sentence(body: string, others = 0): string {
  const closed = body.replace(/[.!?]+$/, "");
  return `${closed}${others > 0 ? ` (+${others} more)` : ""}${closed.endsWith("…") && others === 0 ? "" : "."}`;
}

/** A service's catalog name without its trailing acronym ("Amazon Simple Queue Service (Amazon SQS)"). */
function displayName(name: string): string {
  return name.replace(/\s*\([^()]*\)\s*$/, "");
}

/** A note that follows a colon reads as a clause, so its first word loses its capital unless it is an
 * acronym or camel-case name (two capitals), or a name the profile itself uses (a service such as Lambda). */
function lowerFirst(note: string, profile: ResolvedProfile): string {
  const word = /^[^\s,;:()]+/.exec(note)?.[0] ?? "";
  const names = new Set([...profile.services.flatMap(service => [service.name, service.catalogName ?? ""]), ...profile.patterns.map(pattern => pattern.name)]
    .flatMap(name => name.split(/[^\w-]+/)));
  return /^[A-Z]/.test(word) && !/[A-Z].*[A-Z]/.test(word) && !names.has(word) ? `${word.charAt(0).toLowerCase()}${note.slice(1)}` : note;
}

function patternsNamed(profile: ResolvedProfile, name: string) {
  return profile.patterns.filter(pattern => pattern.name.toLowerCase() === name);
}

function withQuote(why: Omit<Why, "sessionSays">, quote: string | undefined): Why {
  return { ...why, ...(quote === undefined ? {} : { sessionSays: quote }) };
}

/** The rule's pillar and what is missing, when the gap pattern has no note of its own. */
function ruleSummary(source: string, detail: string | undefined): string {
  const split = detail === undefined ? null : /^([^:]+): (.*)$/.exec(detail);
  return split === null ? `${source} is not evident in the cited scope` : `${source} (${split[1]}): ${split[2]}`;
}

/** Fix and Next-level: named for the strongest rule that admitted the session (the first on a tie),
 * the others counted. */
export function lensWhy(lens: "fix" | "next-level", hits: readonly LensHit[], profile: ResolvedProfile, text: SessionText): Why {
  const hit = hits.reduce((best, next) => (next.strength > best.strength ? next : best));
  const patterns = patternsNamed(profile, hit.rule);
  const others = hits.length - 1;
  const evidence = patterns.flatMap(pattern => pattern.evidence);
  const patternNote = patterns.map(pattern => trimNote(pattern.note)).find(note => note !== undefined);
  let summary: string;
  if (lens === "fix") {
    summary = sentence(`Covers your ${patternNote === undefined ? ruleSummary(hit.rule, lensRuleDetail(hit.rule)) : `${hit.rule}: ${lowerFirst(patternNote, profile)}`}`, others);
  } else {
    const aside = [...patterns.map(pattern => pattern.note), ...evidence.map(item => item.note)]
      .map(candidate => trimNote(candidate, true)).find(found => found !== undefined);
    const toward = hit.destination === undefined ? "" : ` toward ${hit.destination}`;
    summary = sentence(`Next step from ${hit.rule}${aside === undefined ? "" : ` (${aside})`}${toward}`, others);
  }
  return withQuote({ summary, ...citationsOf(evidence) }, quoteSite(text, hit.site));
}

/** "src/db/table.ts:14", with the repo in front when the profile spans several. */
function placeOf(citation: Citation, repoCount: number): string {
  const file = repoCount > 1 ? `${citation.repo}/${citation.file}` : citation.file;
  return citation.line === undefined ? file : `${file}:${citation.line}`;
}

/** Explain: the concept the session was taken for, and how the profile says the code uses it. */
export function explainWhy(match: ConceptMatch, profile: ResolvedProfile, text: SessionText): Why {
  const cited = citationsOf(match.concept.citations);
  const note = trimNote(match.concept.note);
  const first = cited.yourCode[0];
  const uses = note !== undefined ? `: ${note}` : first === undefined ? "" : ` at ${placeOf(first, profile.repos.length)}`;
  return withQuote({ summary: sentence(`Explains ${displayName(match.concept.name)}, which this code uses${uses}`), ...cited }, quoteSite(text, match.site));
}

/** a[0], b[0], a[1], b[1], ...: each concept gets its turn before either gets a second place. */
function interleave<T>(a: readonly T[], b: readonly T[]): T[] {
  return Array.from({ length: Math.max(a.length, b.length) }, (_, index) => [a[index], b[index]]).flat().filter((item): item is T => item !== undefined);
}

/** All: the two concepts the session was admitted for, most about first, the strongest with the code's
 * note on it, and what the session says about the first. A demoted session says what it is. */
export function allWhy(matches: readonly ConceptMatch[], demoted: string | undefined, profile: ResolvedProfile, text: SessionText): Why {
  const [first, second] = matches;
  if (first === undefined) throw new Error("an all candidate has no concept it was admitted for");
  const note = trimNote(first.concept.note, true);
  const described = note === undefined ? displayName(first.concept.name) : `${displayName(first.concept.name)} (${note})`;
  const names = second === undefined ? described : `${described} and ${displayName(second.concept.name)}`;
  const pitch = demoted === undefined ? "" : `; ranked lower: ${demoted}`;
  return withQuote({ summary: sentence(`Matches your ${names}${pitch}`), ...citationsOf(interleave(first.concept.citations, second?.concept.citations ?? [])) }, quoteSite(text, first.site));
}
