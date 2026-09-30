import type { Evidence, ResolvedProfile } from "../profile/profile.js";
import { patternPhrase, type ConceptMatch } from "./explain.js";
import { lensRuleDetail, type LensHit } from "./lens-signals.js";
import { unlistedMatches } from "./listing.js";
import type { Reason } from "./score.js";
import { serviceNamePatterns } from "./stack-fit.js";

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
  return `${body.replace(/[.!?]+$/, "")}${others > 0 ? ` (+${others} more)` : ""}.`;
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
    summary = sentence(`Covers your ${patternNote === undefined ? ruleSummary(hit.rule, lensRuleDetail(hit.rule)) : `${hit.rule}: ${patternNote}`}`, others);
  } else {
    const note = patternNote ?? evidence.map(item => trimNote(item.note)).find(found => found !== undefined);
    const toward = hit.destination === undefined ? "" : ` toward ${hit.destination}`;
    summary = sentence(`Next step from ${hit.rule}${note === undefined ? "" : ` (${note})`}${toward}`, others);
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
  return withQuote({ summary: sentence(`Explains ${match.concept.name}, which this code uses${uses}`), ...cited }, quoteSite(text, match.site));
}

/** A thing in the profile that a ranking reason points at: what to call it, how the code uses it,
 * where, and how a session words it. */
interface NamedConcept {
  name: string;
  note: string | undefined;
  evidence: Evidence[];
  matchers: RegExp[];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CONCEPT_REASONS = 2;

/** The profile's service, or pattern, that a `service` or `topic` reason was matched for. */
function conceptOf(reason: Reason, profile: ResolvedProfile): NamedConcept | undefined {
  if (reason.kind === "service") {
    const services = profile.services.filter(service => service.catalogName === reason.evidence);
    if (services.length === 0) return undefined;
    return {
      name: reason.evidence, note: services.map(service => trimNote(service.usage)).find(note => note !== undefined),
      evidence: services.flatMap(service => service.evidence),
      matchers: services.flatMap(service => serviceNamePatterns(service.name, service.catalogName)),
    };
  }
  const patterns = profile.patterns.filter(pattern => pattern.name.toLowerCase() === reason.evidence.toLowerCase());
  if (patterns.length === 0) return undefined;
  const name = patterns[0]!.name;
  return {
    name, note: patterns.map(pattern => trimNote(pattern.note)).find(note => note !== undefined),
    evidence: patterns.flatMap(pattern => pattern.evidence),
    matchers: [patternPhrase(name) ?? new RegExp(`\\b${escapeRegExp(name).replace(/\\?-/g, "[- ]")}\\b`, "i")],
  };
}

/** The first place a concept is named outside an enumeration: in the title if there, else the abstract. */
function siteOf(matchers: readonly RegExp[], text: SessionText): MatchSite | undefined {
  for (const [inTitle, where] of [[true, text.title], [false, text.abstract]] as const) {
    const first = matchers.flatMap(matcher => unlistedMatches(matcher, where)).sort((a, b) => a.index - b.index)[0];
    if (first !== undefined) return { inTitle, index: first.index, length: first[0].length };
  }
  return undefined;
}

/** The ranking reasons of a plain match, read back as the profile's own services and patterns: the
 * two strongest, the strongest with the code's note on it. A session matched only by an area of
 * interest or by shared wording says so, with nothing of the code to cite. */
export function allWhy(reasons: readonly Reason[], profile: ResolvedProfile, text: SessionText): Why {
  const concepts = reasons
    .filter(reason => reason.kind === "service" || reason.kind === "topic")
    .sort((a, b) => b.weight - a.weight)
    .flatMap(reason => conceptOf(reason, profile) ?? [])
    .filter((concept, position, list) => list.findIndex(other => other.name === concept.name) === position)
    .slice(0, CONCEPT_REASONS);
  const [first, second] = concepts;
  if (first === undefined) {
    const interest = reasons.find(reason => reason.kind === "areaOfInterest");
    const shared = reasons.find(reason => reason.kind === "text");
    const term = interest?.evidence ?? shared?.evidence.split(", ")[0];
    const site = term === undefined ? undefined : siteOf([new RegExp(`(?<![\\w-])${escapeRegExp(term)}(?![\\w-])`, "i")], text);
    const summary = interest !== undefined ? `Matches your interest in ${interest.evidence}`
      : `Matches the wording of your profile: ${shared?.evidence ?? "no shared terms"}`;
    return withQuote({ summary: sentence(summary), yourCode: [] }, site === undefined ? undefined : quoteSite(text, site));
  }
  const described = first.note === undefined ? first.name : `${first.name} (${first.note})`;
  const summary = second === undefined ? described : `${described} and ${second.name}`;
  const site = concepts.map(concept => siteOf(concept.matchers, text)).find(found => found !== undefined);
  return withQuote({ summary: sentence(`Matches your ${summary}`), ...citationsOf(first.evidence) }, site === undefined ? undefined : quoteSite(text, site));
}
