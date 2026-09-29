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

/**
 * Whether a session is about the profile's stack: it lists one of the profile's core (not
 * supporting) resolved services, or its title or abstract names one of them, by catalog name, short
 * name or the profile's own spelling. Supporting services never admit, since they are not what the
 * product runs on. Returns `undefined` when the profile has no core service, leaving nothing to fit
 * against, so the gate is off rather than rejecting everything.
 */
export function buildStackFit(profile: ResolvedProfile): StackFit | undefined {
  const core = profile.services.filter(service => service.role !== "supporting");
  if (core.length === 0) return undefined;
  const listed = new Set(core.flatMap(service => service.catalogName === null ? [] : [service.catalogName]));
  const terms = [...new Set(core.flatMap(service => [
    ...(service.catalogName === null ? [] : nameForms(service.catalogName)), ...nameForms(service.name),
  ].map(term => term.toLowerCase())))];
  const named = new RegExp(`(?<![\\w-])(?:${terms.map(escapeRegExp).join("|")})(?![\\w-])`, "i");
  return (record, abstract) =>
    record.services.some(service => listed.has(service)) || named.test(record.title) || named.test(abstract);
}
