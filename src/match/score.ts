import { getOwnTermCount, tokenize, type IndexRecord } from "../catalog/index-record.js";

/**
 * What put a candidate session on the list, in the caller's own vocabulary -- shown to a user or
 * an agent deciding whether to trust the ranking. `kind` is the extension point for a later
 * phase: `"pillarGap"` for the Fix lens and `"migrationPath"` for the Next level, added without
 * touching this module's arithmetic.
 */
export interface Reason {
  kind: "service" | "topic" | "areaOfInterest" | "text" | "level" | "format";
  /** A one-line, human-readable explanation, e.g. `Uses Amazon DynamoDB, which this session
   * covers.` */
  detail: string;
  /** This reason's own contribution to the total score -- summing every reason's `weight`
   * reproduces `score` exactly. */
  weight: number;
  /** The specific value that matched -- a catalog service name, a topic, or the query terms a
   * text match found -- so the detail can be checked against the session's own real fields. */
  evidence: string;
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

interface TextMatchResult {
  score: number;
  matchedTerms: string[];
}

function scoreText(record: IndexRecord, queryText: string): TextMatchResult | null {
  const queryTerms = Object.keys(tokenize(queryText));
  if (queryTerms.length === 0) {
    return null;
  }

  let titleScore = 0;
  let rawBodyScore = 0;
  const matchedTerms: string[] = [];

  for (const term of queryTerms) {
    let matched = false;

    const titleTf = getOwnTermCount(record.titleTerms, term);
    if (titleTf !== undefined) {
      titleScore += TITLE_TERM_WEIGHT * saturate(titleTf);
      matched = true;
    }

    const bodyTf = getOwnTermCount(record.bodyTerms, term);
    if (bodyTf !== undefined) {
      rawBodyScore += BODY_TERM_WEIGHT * saturate(bodyTf);
      matched = true;
    }

    if (matched) {
      matchedTerms.push(term);
    }
  }

  if (matchedTerms.length === 0) {
    return null;
  }

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
 */
export function scoreSession(record: IndexRecord, query: MatchQuery): ScoredSession {
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

  const textResult = scoreText(record, query.text);
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
