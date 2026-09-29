import type { Evidence } from "../profile/profile.js";
import { getOwnTermCount, tokenize, type IndexRecord } from "../catalog/index-record.js";

/**
 * What put a candidate session on the list, in the caller's own vocabulary -- shown to a user or
 * an agent deciding whether to trust the ranking. `kind` is the extension point for a later
 * phase: `"pillarGap"` for the Fix lens and `"migrationPath"` for the Next level, added without
 * touching this module's arithmetic.
 */
export interface Reason {
  kind: "service" | "topic" | "areaOfInterest" | "text" | "level" | "format" | "pillarGap" | "migrationPath";
  /** A one-line, human-readable explanation, e.g. `Uses Amazon DynamoDB, which this session
   * covers.` */
  detail: string;
  /** This reason's own contribution to the total score -- summing every reason's `weight`
   * reproduces `score` exactly. */
  weight: number;
  /** The specific value that matched -- a catalog service name, a topic, or the query terms a
   * text match found -- so the detail can be checked against the session's own real fields. */
  evidence: string;
  /** Source citations for a pillarGap or migrationPath reason. */
  profileEvidence?: Evidence[];
}

export interface MatchQuery {
  /** Catalog display names, already resolved (see `profile.ts`) -- checked for an exact match
   * against a session's own `services`. The single strongest signal: a session that literally
   * covers a service the profile actually uses. */
  services: readonly string[];
  /** Checked for a case-insensitive exact match against a session's `topics`. */
  topics: readonly string[];
  /** Checked for a case-insensitive exact match against a session's `areasOfInterest`. */
  areasOfInterest: readonly string[];
  /** Free text -- tokenized the same way the index was built -- scored BM25-lite against the
   * session's title and body term maps. From an agent-authored profile, this is everywhere the
   * profile has prose: pattern names and notes, service `usage`, `interests`, and `intents.text`,
   * joined by whoever builds this query (`match.ts`, not this module). */
  text: string;
}

export interface ScoredSession {
  /** The sum of every reason's `weight`. */
  score: number;
  reasons: Reason[];
}

export interface CorpusStats {
  /** Total number of documents `documentFrequencies` below was computed over. */
  totalDocuments: number;
  /** How many documents (title or body, regardless of how many times within one) contain each
   * term at all. Only terms present in at least one document need appear here. */
  documentFrequencies: ReadonlyMap<string, number>;
}

/**
 * Builds corpus-wide statistics from every record in a loaded index -- specifically, each term's
 * document frequency, the "how rare is this term across the whole catalog" half of BM25 that
 * per-document term-frequency saturation alone can't provide. Saturation only caps how much
 * *repeating a term within one document* can matter; it says nothing about a term that shows up in
 * nearly every document to begin with (see `scoreText`'s own inverse-document-frequency weighting
 * below, and `tests/match/match.test.ts`'s real-catalog "amazon" vs. "guide" test, which is the
 * concrete case this exists to fix).
 */
export function buildCorpusStats(records: readonly IndexRecord[]): CorpusStats {
  const documentFrequencies = new Map<string, number>();
  for (const recordInCorpus of records) {
    const termsInRecord = new Set<string>([
      ...Object.keys(recordInCorpus.titleTerms),
      ...Object.keys(recordInCorpus.bodyTerms),
    ]);
    for (const term of termsInRecord) {
      documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
    }
  }
  return { totalDocuments: records.length, documentFrequencies };
}

/**
 * A term's inverse document frequency, Okapi BM25's own formula:
 * `ln((totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1)`. Small for a
 * term that appears in nearly every document in the corpus (it distinguishes almost nothing between
 * them) and largest for a term that appears in only one or two -- but never exactly zero and never
 * negative, however common the term is, because of the "+1" inside the outer log: a plain
 * `ln(totalDocuments / documentFrequency)` would hit exactly zero for a fully-universal term, which
 * is a sharper cliff than real corpora need (a term in 100% of documents today could easily be in
 * 98% after the next sync) and needlessly special-cases something the "+1" already handles for
 * free. `corpusStats` is optional: omitting it treats every term as equally informative (weight 1,
 * the pre-idf behavior), which is what almost every other test in this module's own test file wants
 * -- they test term-frequency saturation and title-weighting in isolation and would otherwise need
 * to construct an unrelated corpus just to keep scoring anything. `match.ts`, the only real caller,
 * always supplies real statistics built from the whole loaded catalog.
 */
function idfWeight(term: string, corpusStats: CorpusStats | undefined): number {
  if (corpusStats === undefined) {
    return 1;
  }
  const documentFrequency = corpusStats.documentFrequencies.get(term) ?? 0;
  return Math.log(
    (corpusStats.totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1,
  );
}

/** An exact catalog service match is the strongest signal this scorer has: the profile named a
 * real service by its catalog display name, and the session covers exactly that service. */
const SERVICE_MATCH_WEIGHT = 50;
/** A topic or area-of-interest match is a real signal, but a much broader one than a specific
 * service -- many sessions can share a topic like "Serverless" without being about the same
 * thing at all. */
const TOPIC_MATCH_WEIGHT = 12;
const AREA_OF_INTEREST_MATCH_WEIGHT = 12;

/** A title term match is weighted higher than the same term appearing only in the body (abstract
 * plus taxonomy fields) -- a title hit is a much stronger relevance signal, the same weighting
 * `catalog/query.ts`'s local search already uses.
 *
 * No separate document-length normalization is applied on top of this. An earlier version divided
 * the body score by the session's own total body-term count, meant to stop a long abstract from
 * outscoring a short precise title purely by having more text to accumulate matches over -- but
 * self-referential length normalization (dividing a document's score by its own length, rather
 * than a corpus-wide average the way real BM25 does) backfires on a document that repeats one
 * relevant term many times with nothing else around it: its "length" grows exactly as fast as its
 * raw score, so the normalized score actually *drops* below a barely-repeated version, the
 * opposite of merely saturating. Confirmed by this module's own saturation test, which failed
 * exactly that way with length normalization in place. Per-term saturation below, combined with
 * title terms already being weighted `TITLE_TERM_WEIGHT`/`BODY_TERM_WEIGHT` = 3x a body term, is
 * enough on its own for a short precise title to outscore a long abstract that only mentions the
 * same terms in passing (see `tests/match/score.test.ts`'s "does not let a long abstract outscore
 * a short precise title") -- a body term's contribution can never exceed `BODY_TERM_WEIGHT` per
 * term regardless of repetition, while a title term's caps at `TITLE_TERM_WEIGHT`. */
const TITLE_TERM_WEIGHT = 3;
const BODY_TERM_WEIGHT = 1;

/** BM25-style term-frequency saturation constant: a term's contribution approaches its own
 * weight asymptotically as it repeats, rather than scaling linearly with occurrence count -- the
 * marginal 27th occurrence of a word buys almost nothing over the 3rd. */
const TERM_SATURATION_K = 1.5;

function saturate(termFrequency: number): number {
  return termFrequency / (termFrequency + TERM_SATURATION_K);
}

/** The most matched terms a "text" reason lists as evidence -- a session matching a dozen query
 * terms is still one reason, not a dozen; readability caps how much is worth showing. */
const MAX_LISTED_TERMS = 8;

interface TextMatchResult {
  score: number;
  matchedTerms: string[];
}

function scoreText(
  record: IndexRecord,
  queryText: string,
  corpusStats: CorpusStats | undefined,
): TextMatchResult | null {
  // The profile's free text is a query, not source material for the index -- a lowercase "ai" in
  // an agent's note must survive to be compared against the index, which may carry "ai" from the
  // catalog's own capitalized "AI" copy (see index-record.ts's tokenize/keepShortTokens).
  const queryTerms = Object.keys(tokenize(queryText, { keepShortTokens: true }));
  if (queryTerms.length === 0) {
    return null;
  }

  let titleScore = 0;
  let rawBodyScore = 0;
  const contributions: { term: string; weight: number }[] = [];

  for (const term of queryTerms) {
    let matched = false;
    let contribution = 0;
    const weight = idfWeight(term, corpusStats);

    const titleTf = getOwnTermCount(record.titleTerms, term);
    if (titleTf !== undefined) {
      const titleContribution = TITLE_TERM_WEIGHT * saturate(titleTf) * weight;
      titleScore += titleContribution;
      contribution += titleContribution;
      matched = true;
    }

    const bodyTf = getOwnTermCount(record.bodyTerms, term);
    if (bodyTf !== undefined) {
      const bodyContribution = BODY_TERM_WEIGHT * saturate(bodyTf) * weight;
      rawBodyScore += bodyContribution;
      contribution += bodyContribution;
      matched = true;
    }

    if (matched) {
      contributions.push({ term, weight: contribution });
    }
  }

  if (contributions.length === 0) {
    return null;
  }

  // Listed strongest-first so the reason reads as an explanation of the score, not a restatement
  // of whatever order the query happened to name terms in -- a near-universal word with almost no
  // idf weight (see `idfWeight`) would otherwise lead the list despite explaining almost none of
  // it. Capped at `MAX_LISTED_TERMS` for readability; the cap only trims what's *listed* here, not
  // `score` above, which always reflects every matched term regardless of how many are shown.
  const matchedTerms = contributions
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_LISTED_TERMS)
    .map((c) => c.term);

  return { score: titleScore + rawBodyScore, matchedTerms };
}

/**
 * Scores one session against a match query, returning every reason that contributed alongside
 * the total score -- `score` is always the sum of every `reasons[].weight`, so a caller never
 * has to trust the two numbers agree independently.
 *
 * Signal precedence, strongest to weakest: an exact catalog service match, then a topic or area-
 * of-interest match, then free-text overlap. This isn't enforced by clamping (a session with
 * several weaker signals can still outscore one with a single stronger one), only by each tier's
 * weight being large enough that one tier's match normally dominates a lower tier's on its own.
 *
 * Returns `{ score: 0, reasons: [] }` for a session sharing nothing with the query -- a zero
 * score is a real, reportable outcome, not an error.
 *
 * `corpusStats` (optional, see `buildCorpusStats`) weights each matched text term by its inverse
 * document frequency across the corpus it was built from -- omit it to treat every term as equally
 * informative, which is what this module's own tests want when they're testing something other
 * than corpus-wide rarity itself.
 */
export function scoreSession(
  record: IndexRecord,
  query: MatchQuery,
  corpusStats?: CorpusStats,
): ScoredSession {
  const reasons: Reason[] = [];

  for (const service of query.services) {
    if (record.services.includes(service)) {
      reasons.push({
        kind: "service",
        detail: `Uses ${service}, which this session covers.`,
        weight: SERVICE_MATCH_WEIGHT,
        evidence: service,
      });
    }
  }

  for (const topic of query.topics) {
    const matched = record.topics.find((t) => t.toLowerCase() === topic.toLowerCase());
    if (matched !== undefined) {
      reasons.push({
        kind: "topic",
        detail: `Matches the topic "${matched}".`,
        weight: TOPIC_MATCH_WEIGHT,
        evidence: matched,
      });
    }
  }

  for (const interest of query.areasOfInterest) {
    const matched = record.areasOfInterest.find((a) => a.toLowerCase() === interest.toLowerCase());
    if (matched !== undefined) {
      reasons.push({
        kind: "areaOfInterest",
        detail: `Matches the area of interest "${matched}".`,
        weight: AREA_OF_INTEREST_MATCH_WEIGHT,
        evidence: matched,
      });
    }
  }

  const textResult = scoreText(record, query.text, corpusStats);
  if (textResult !== null && textResult.score > 0) {
    // Deliberately not rounded here: BM25-lite's saturation formula routinely produces
    // floating-point noise (3 * (1/2.5) is 1.2000000000000002, not a clean 1.2), but this value
    // is still used for sorting (see match.ts), so it needs to keep full precision. Only the
    // final, agent-facing output is rounded, once, after ranking is settled -- see
    // match.ts's own doc comment.
    reasons.push({
      kind: "text",
      detail: `Text overlap on: ${textResult.matchedTerms.join(", ")}.`,
      weight: textResult.score,
      evidence: textResult.matchedTerms.join(", "),
    });
  }

  const score = reasons.reduce((sum, reason) => sum + reason.weight, 0);
  return { score, reasons };
}
