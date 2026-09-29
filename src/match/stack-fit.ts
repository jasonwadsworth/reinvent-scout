import type { IndexRecord } from "../catalog/index-record.js";
import type { ResolvedProfile } from "../profile/profile.js";

export type StackFit = (record: IndexRecord, abstract: string) => boolean;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Amazon Simple Queue Service (Amazon SQS)" names itself three ways: the whole, the part before
 * the parenthesis, and the parenthesized short name; each is also tried without its "Amazon" or
 * "AWS" prefix ("Lambda" for "AWS Lambda"). */
function nameForms(name: string): string[] {
  const parenthesized = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(name);
  const wholes = parenthesized === null ? [name] : [name, parenthesized[1]!, parenthesized[2]!];
  return wholes.flatMap(whole => [whole, whole.replace(/^(?:Amazon|AWS)\s+/i, "")])
    .map(form => form.trim())
    .filter(form => form.length >= 2);
}

export interface StackFitOptions {
  /** Distinct core services a session must share with the profile. Default 1. */
  minDistinct?: number;
  /** With `catalog`: a session sharing just one core service still fits when that service is listed
   * by fewer than this fraction of catalog sessions, so a distinctive service is enough on its own
   * while a near-universal one (CloudWatch, S3) is not. */
  rareBelow?: number;
  catalog?: readonly IndexRecord[];
}

interface CoreService {
  catalogName: string | null;
  named: RegExp;
  /** Fraction of catalog sessions that list it; 0 when unknown or unlisted. */
  frequency: number;
}

/**
 * Whether a session is about the profile's stack: it lists or names (by catalog name, short name or
 * the profile's own spelling, in its title or abstract) enough of the profile's core services --
 * `minDistinct` of them, or a single one that is rare in the catalog (see `StackFitOptions`).
 * Supporting services never count, since they are not what the product runs on. Returns
 * `undefined` when the profile has no core service, leaving nothing to fit against, so the gate is
 * off rather than rejecting everything.
 */
export function buildStackFit(profile: ResolvedProfile, options: StackFitOptions = {}): StackFit | undefined {
  const core = profile.services.filter(service => service.role !== "supporting");
  if (core.length === 0) return undefined;
  const minDistinct = options.minDistinct ?? 1;
  const listedCount = new Map<string, number>();
  for (const record of options.catalog ?? []) {
    for (const service of new Set(record.services)) listedCount.set(service, (listedCount.get(service) ?? 0) + 1);
  }
  const total = options.catalog?.length ?? 0;
  const services: CoreService[] = [];
  const seen = new Set<string>();
  for (const service of core) {
    const key = service.catalogName ?? service.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const terms = [...new Set([
      ...(service.catalogName === null ? [] : nameForms(service.catalogName)), ...nameForms(service.name),
    ].map(term => term.toLowerCase()))];
    services.push({
      catalogName: service.catalogName,
      named: new RegExp(`(?<![\\w-])(?:${terms.map(escapeRegExp).join("|")})(?![\\w-])`, "i"),
      frequency: service.catalogName === null || total === 0 ? 0 : (listedCount.get(service.catalogName) ?? 0) / total,
    });
  }
  return (record, abstract) => {
    const shared = services.filter(service =>
      (service.catalogName !== null && record.services.includes(service.catalogName))
      || service.named.test(record.title) || service.named.test(abstract));
    if (shared.length >= minDistinct) return true;
    return options.rareBelow !== undefined && shared.length > 0 && shared.every(service => service.frequency < options.rareBelow!);
  };
}
