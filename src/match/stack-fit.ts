import type { IndexRecord } from "../catalog/index-record.js";
import type { ResolvedProfile } from "../profile/profile.js";

export interface StackFitQuery {
  /** Catalog services that do not count toward the fit. */
  without?: readonly string[];
  /** Overrides the gate's own minimum of distinct services, and disables the rare-service path. */
  minDistinct?: number;
  /** Catalog services that close the gap the caller is looking for. Each one the session lists
   * counts as one more distinct service alongside the profile's own, and at least one must be
   * listed: a session about the tools lists the tools. Never opens a profile that has no core
   * service. */
  remedy?: readonly string[];
  /** Catalog services whose own sessions fit when the profile lists the same service in any role
   * (a session on testing the IaC tool the profile deploys with). Never opens a profile that has
   * no core service. */
  tools?: readonly string[];
}

/** A caller that has to know the session is about the profile's stack beyond one service (a rule's
 * own source) narrows the gate with `query`. */
export type StackFit = (record: IndexRecord, abstract: string, query?: StackFitQuery) => boolean;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface NameForm {
  text: string;
  caseSensitive: boolean;
}

/**
 * Service short names that are ordinary English words. Bare, they read as prose ("Agents amplify
 * all of them", "Connect your systems"), so they count only inside a prefixed name ("AWS Amplify",
 * "Amazon Connect") or the full catalog display name. Distinctive product names (Lambda, DynamoDB,
 * Bedrock, Textract, Kendra...) and acronyms (S3, SQS) are not listed: they match bare, as
 * capitalized whole words. Lowercase, as compared.
 */
export const PREFIX_REQUIRED_SERVICE_NAMES: readonly string[] = [
  "amplify", "connect", "glue", "batch", "backup", "config", "shield", "inspector", "detective",
  "transcribe", "polly", "translate", "comprehend", "forecast", "personalize",
];

const stripPrefix = (name: string): string => name.replace(/^(?:Amazon|AWS)\s+/i, "");
const requiresPrefix = (name: string): boolean => PREFIX_REQUIRED_SERVICE_NAMES.includes(name.toLowerCase());

/** "Amazon Simple Queue Service (Amazon SQS)" names itself three ways: the whole, the part before
 * the parenthesis, and the parenthesized short name. Each whole matches in any case. Each is also
 * tried without its "Amazon" or "AWS" prefix ("Lambda" for "AWS Lambda", "SQS" for "Amazon SQS"),
 * but only as written (case-sensitive) and never for an ordinary-word name. */
function catalogForms(name: string): NameForm[] {
  const parenthesized = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(name);
  const wholes = (parenthesized === null ? [name] : [name, parenthesized[1]!, parenthesized[2]!]).map(whole => whole.trim());
  return wholes.flatMap(whole => {
    const stripped = stripPrefix(whole).trim();
    return [
      { text: whole, caseSensitive: false },
      ...(stripped === whole || requiresPrefix(stripped) ? [] : [{ text: stripped, caseSensitive: true }]),
    ];
  }).filter(form => form.text.length >= 2);
}

/** The profile's own spelling of a service. It gets no special treatment: an ordinary-word name
 * needs its prefix like any other spelling, and otherwise it matches as written, so a bare
 * "Amplify" is never the verb. Exceptions: a spelling equal to the catalog display name ignoring
 * case matches in any case ("kiro" for "Kiro"), and one the catalog's cased short name already
 * covers adds nothing ("lambda" for AWS Lambda would read "a lambda expression" as a mention). */
function profileForms(name: string, catalogName: string | null, catalog: readonly NameForm[]): NameForm[] {
  const whole = name.trim();
  if (stripPrefix(whole).trim() !== whole) return catalogForms(whole);
  if (whole.length < 2) return [];
  if (requiresPrefix(whole)) {
    return [`Amazon ${whole}`, `AWS ${whole}`].map(text => ({ text, caseSensitive: false }));
  }
  if (catalog.some(form => form.caseSensitive && form.text.toLowerCase() === whole.toLowerCase())) return [];
  return [{ text: whole, caseSensitive: catalogName?.toLowerCase() !== whole.toLowerCase() }];
}

/** Every way a text can name a service: the catalog display name, its parenthesized and
 * prefix-stripped short forms, and the profile's own spelling (see `catalogForms` and
 * `profileForms` for what each form accepts). One case-insensitive and one case-sensitive pattern,
 * either absent when no form needs it. */
export function serviceNamePatterns(name: string, catalogName: string | null): RegExp[] {
  const fromCatalog = catalogName === null ? [] : catalogForms(catalogName);
  const forms = [...fromCatalog, ...profileForms(name, catalogName, fromCatalog)];
  const alternation = (caseSensitive: boolean): RegExp | undefined => {
    const texts = [...new Set(forms.filter(form => form.caseSensitive === caseSensitive).map(form => form.text))];
    return texts.length === 0 ? undefined
      : new RegExp(`(?<![\\w-])(?:${texts.map(escapeRegExp).join("|")})(?![\\w-])`, caseSensitive ? "" : "i");
  };
  return [alternation(false), alternation(true)].filter((pattern): pattern is RegExp => pattern !== undefined);
}

/**
 * Platform services: what nearly every AWS workload runs on rather than what the product is built
 * from. Sharing CloudWatch or S3 with a session says nothing about the stack, so they never count
 * as core here, whatever role the profile gave them. Catalog display names.
 */
export const PLATFORM_SERVICES: readonly string[] = [
  "Amazon CloudWatch",
  "Amazon Virtual Private Cloud (Amazon VPC)",
  "Amazon Simple Storage Service (Amazon S3)",
  "Amazon Route 53",
  "AWS Certificate Manager (ACM)",
  "AWS Cloud Development Kit (AWS CDK)",
  "AWS CloudFormation",
  "AWS Identity and Access Management (IAM)",
  "AWS Security Token Service (AWS STS)",
  "AWS Key Management Service (AWS KMS)",
  "AWS Secrets Manager",
  "AWS Systems Manager",
  "AWS CloudTrail",
];

function isCore(service: ResolvedProfile["services"][number]): boolean {
  return service.role !== "supporting"
    && (service.catalogName === null || !PLATFORM_SERVICES.includes(service.catalogName));
}

export function hasCoreService(profile: ResolvedProfile): boolean {
  return profile.services.some(isCore);
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
  named: (text: string) => boolean;
  /** Fraction of catalog sessions that list it; 0 when unlisted, 1 when the profile's name did not
   * resolve, so an unresolved name is never rare. */
  frequency: number;
}

/**
 * Whether a session is about the profile's stack: it lists or names (by catalog name, short name or
 * the profile's own spelling, in its title or abstract) enough of the profile's core services --
 * `minDistinct` of them, or a single one that is rare in the catalog (see `StackFitOptions`).
 * Supporting and platform services (`PLATFORM_SERVICES`) never count, since they are not what the
 * product is built from. An unresolved name counts toward `minDistinct` but is never rare. A profile with no
 * core service has no stack to fit against, so nothing fits (see `hasCoreService`); an open gate
 * would admit every session that mentions a gap phrase, on any stack.
 */
export function buildStackFit(profile: ResolvedProfile, options: StackFitOptions = {}): StackFit {
  const core = profile.services.filter(isCore);
  if (core.length === 0) return () => false;
  const minDistinct = options.minDistinct ?? 1;
  const profileTools = new Set(profile.services.flatMap(service => service.catalogName === null ? [] : [service.catalogName]));
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
    const patterns = serviceNamePatterns(service.name, service.catalogName);
    services.push({
      catalogName: service.catalogName,
      named: text => patterns.some(pattern => pattern.test(text)),
      frequency: service.catalogName === null ? 1 : total === 0 ? 0 : (listedCount.get(service.catalogName) ?? 0) / total,
    });
  }
  return (record, abstract, query = {}) => {
    const without = query.without ?? [];
    if (query.tools?.some(name => profileTools.has(name) && record.services.includes(name)) === true) return true;
    const shared = services.filter(service =>
      !(service.catalogName !== null && without.includes(service.catalogName))
      && ((service.catalogName !== null && record.services.includes(service.catalogName))
        || service.named(record.title) || service.named(abstract)));
    const needed = query.minDistinct ?? minDistinct;
    if (shared.length >= needed) return true;
    const remedies = (query.remedy ?? []).filter(name => record.services.includes(name)
      && !shared.some(service => service.catalogName === name)).length;
    if (remedies > 0) return shared.length + remedies >= needed;
    return query.minDistinct === undefined && options.rareBelow !== undefined && shared.length > 0
      && shared.every(service => service.frequency < options.rareBelow!);
  };
}
