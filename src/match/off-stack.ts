import type { ResolvedProfile } from "../profile/profile.js";
import { patternPhrase } from "./concepts.js";
import { OFF_STACK_TOOLS, PLATFORM_SERVICES, serviceNamePatterns } from "./stack-fit.js";

/** A technology a title can be about, and how a title words it. */
export interface OffStackTopic {
  label: string;
  phrases: readonly RegExp[];
}

/** The technologies a profile does not use, and the forms of the services it does (which a title can be about instead). */
export interface OffStack {
  topics: readonly OffStackTopic[];
  used: readonly RegExp[];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (text: string, flags = ""): RegExp => new RegExp(`(?<![\\w-])${escapeRegExp(text)}(?![\\w-])`, flags);
const shortName = (catalogName: string): string => catalogName.replace(/\s*\(.*\)\s*$/, "");
const PREFIX = /^(?:Amazon|AWS)\s+/i;

/**
 * How a title names a catalog service unmistakably: the full name in any case; the parenthesized short form only when it
 * carries its own "Amazon" or "AWS" ("Amazon EKS", never "US" of "AWS GovCloud (US)"); and the name without its prefix
 * only when it is a product word (DynamoDB, ElastiCache, S3), as written, never an ordinary word or an acronym
 * ("Transform", "Context", "CLI").
 */
function distinctiveForms(catalogName: string): RegExp[] {
  const parenthesized = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(catalogName);
  const wholes = parenthesized === null ? [catalogName] : [parenthesized[1]!, ...(PREFIX.test(parenthesized[2]!) ? [parenthesized[2]!] : [])].map(whole => whole.trim());
  const bare = wholes.map(whole => whole.replace(PREFIX, "")).filter((stripped, index) => stripped !== wholes[index] && (/[a-z][A-Z]/.test(stripped) || /\d/.test(stripped)));
  return [...wholes.map(whole => word(whole, "i")), ...bare.map(text => word(text))];
}

/**
 * The catalog's services, and the curated tools, that the profile does not use. A service is used when the profile names it
 * by its catalog name; a tool when a service of the profile names it (Terraform, or the EKS catalog name for Kubernetes) or
 * a pattern words it ("eks" for Kubernetes). Platform services (IAM, S3, CloudWatch...) are never off-stack.
 */
export function offStackOf(profile: ResolvedProfile, catalogServices: readonly string[]): OffStack {
  const usedNames = new Set(profile.services.flatMap(service => service.catalogName === null ? [] : [service.catalogName]));
  const services = [...new Set(catalogServices)].filter(name => !usedNames.has(name) && !PLATFORM_SERVICES.includes(name))
    .map((name): OffStackTopic => ({ label: shortName(name), phrases: distinctiveForms(name) }));
  const profileNames = profile.services.flatMap(service => [service.name, ...(service.catalogName === null ? [] : [service.catalogName])]);
  const tools = OFF_STACK_TOOLS.filter(tool => !profileNames.some(name => word(tool).test(name))
    && !profile.patterns.some(pattern => patternPhrase(pattern.name)?.test(tool) === true))
    .map((tool): OffStackTopic => ({ label: tool, phrases: [word(tool)] }));
  return { topics: [...services, ...tools], used: profile.services.flatMap(service => serviceNamePatterns(service.name, service.catalogName)) };
}

interface Span { label: string; start: number; end: number }

function spansOf(regexes: readonly RegExp[], title: string, label: (text: string) => string): Span[] {
  return regexes.flatMap(regex => [...title.matchAll(new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`))]
    .map(match => ({ label: label(match[0]), start: match.index, end: match.index + match[0].length })));
}

const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;
/** Two spans with nothing between them but whitespace or a hyphen: one name qualifying the other ("Aurora PostgreSQL"). */
const touching = (title: string, a: Span, b: Span): boolean =>
  !overlaps(a, b) && /^[\s-]*$/.test(title.slice(Math.min(a.end, b.end), Math.max(a.start, b.start)));

/** A comparison, or a move from one technology to another, is about both. */
const COMPARISON = /\bvs\.?(?=\s)|\bversus\b|\bcompar(?:e|es|ing|ison)\b|\bbetween\b|\bfrom\b[^]*\bto\b|\binstead of\b/i;

/**
 * The technology a title is about that the profile does not use, or `undefined`. Only the title is read. A technology the
 * title names inside, or right next to, a service the profile uses is not off-stack (Amazon Bedrock inside Amazon Bedrock
 * AgentCore, PostgreSQL after Aurora), and of two overlapping names the longer wins. A comparison is exempt only when
 * the title names two technologies.
 */
export function offStackAbout(title: string, off: OffStack): string | undefined {
  const named = off.topics.flatMap(topic => spansOf(topic.phrases, title, () => topic.label));
  const used = spansOf(off.used, title, text => text.toLowerCase());
  const remaining = named
    .filter(span => !named.some(other => other !== span && other.start <= span.start && span.end <= other.end && other.end - other.start > span.end - span.start))
    .filter(span => !used.some(service => overlaps(span, service) || touching(title, span, service)))
    .sort((a, b) => a.start - b.start);
  const first = remaining[0];
  if (first === undefined) return undefined;
  const technologies = new Set([...remaining.map(span => span.label.toLowerCase()), ...used.map(span => span.label)]);
  return COMPARISON.test(title) && technologies.size >= 2 ? undefined : first.label;
}
