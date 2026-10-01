import type { ResolvedProfile } from "./profile.js";

/** The `profile validate` report, shared by the CLI (`--json`) and the MCP `validate_profile` tool so
 * both print the same object. `fits` decides whether a candidate response is within the caller's
 * size budget; the default accepts everything. */
export interface CompactResolvedService {
  name: string;
  catalogName: string | null;
}

export interface ValidateProfileResponse {
  services: CompactResolvedService[];
  patterns: string[];
  unresolvedServices: string[];
  counts: { services: number; patterns: number; unresolvedServices: number };
  truncated: boolean;
  omitted: number;
  hint?: string;
  /** Non-blocking: the profile is valid, but something in it makes it less checkable. Absent when
   * there is nothing to say, so a report without warnings is unchanged. */
  warnings?: string[];
}

const COMMON_DIRECTORIES = "src|lib|infra|infrastructure|services|packages|apps|cdk|stacks|tests?|scripts|shared|cmd|internal|terraform|modules|handlers";
const FILE_EXTENSIONS = "tsx?|jsx?|mjs|cjs|py|java|kt|go|rb|cs|tf|ya?ml|json|toml|sh|md|dockerfile";
/** What a note uses to say which files it looked at: a name with a source-file extension, a path with at
 * least two directory segments (`services/user/src`), a dot directory or a well-known top directory
 * (`.github/workflows`, `src/handlers`), a directory with a trailing slash (`services/`),
 * or a glob (`**` or `*.ext`). A bare slash or star does not count: "5xx/unhealthy", an IAM action like
 * "cognito-idp:*", a quoted "'*'" resource and an ARN ending in "/*" name no file. */
const NAMES_WHAT_WAS_INSPECTED = new RegExp(
  [
    `[\\w@-]+\\.(?:${FILE_EXTENSIONS})\\b`,
    "(?:[\\w.@-]+/){2,}",
    "[\\w.@-]+/(?![\\w.@*-])",
    `\\.[\\w-]+/[\\w.@-]+`,
    `\\b(?:${COMMON_DIRECTORIES})/[\\w.@-]+`,
    "\\*\\*",
    "\\*\\.[a-z]\\w*",
  ].join("|"),
  "i",
);

/** One warning per `gap-*` pattern whose note names no file, path or glob: a reviewer cannot tell
 * what the profiler searched, so an absence or a "present everywhere" cannot be rechecked. */
function gapWarnings(resolved: ResolvedProfile): string[] {
  return resolved.patterns
    .filter(pattern => pattern.name.startsWith("gap-") && !NAMES_WHAT_WAS_INSPECTED.test(pattern.note ?? ""))
    .map(
      pattern =>
        `${pattern.name}: the note names no file, path or glob, so what was inspected cannot be checked. ` +
        "Say which files or search you used and how many resources you counted.",
    );
}

/** Builds one services/patterns-count's worth of response -- the one place that decides the shape
 * for a given pair, so the everything-fits attempt and every trial inside both truncation loops
 * below measure the exact same shape the caller will actually receive. `unresolvedServices` is
 * *derived* from `services` here, not passed in separately -- a profile where every service is
 * unresolvable (the realistic worst case, not a contrived one: an agent profiling a repo against
 * the wrong event's catalog would look exactly like this) would otherwise make `unresolvedServices`
 * alone as large as the untruncated `services` list, defeating the truncation entirely. Deriving it
 * from whatever's actually included keeps both lists internally consistent (every name in
 * `unresolvedServices` is also present in `services`) and shrinks them together under the same
 * budget. */
function buildValidateProfileResponse(
  services: CompactResolvedService[],
  patterns: string[],
  counts: ValidateProfileResponse["counts"],
  totalServices: number,
  totalPatterns: number,
  truncated: boolean,
  warnings: string[],
): ValidateProfileResponse {
  const omitted = totalServices - services.length + (totalPatterns - patterns.length);
  const unresolvedServices = services
    .filter((service) => service.catalogName === null)
    .map((service) => service.name);
  return {
    services,
    patterns,
    unresolvedServices,
    counts,
    truncated,
    omitted,
    ...(warnings.length === 0 ? {} : { warnings }),
    ...(truncated
      ? {
          hint:
            `${omitted} services and/or patterns were left out to fit the response budget -- ` +
            "counts still reports the true totals, but unresolvedServices only names the ones " +
            "still present above.",
        }
      : {}),
  };
}

/** pr-reviewer's finding: echoing the whole resolved profile (every service's `evidence`, `usage`,
 * and every pattern's `note`/`evidence`, plus `repos`) breaks the README's own "every tool holds
 * its response to a 30 KB budget" claim for a profile with many services -- measured at 45,439
 * bytes for a 120-service profile, comfortably over budget, and none of that evidence is data this
 * tool computed anyway: it's the agent's own input echoed back. This reports only what
 * `resolveProfile` actually decided: each service's name and its resolved `catalogName` (or
 * `null`), each pattern's bare name, `unresolvedServices`, and counts.
 *
 * Both `services` (and, derived from it, `unresolvedServices`) *and* `patterns` are enforced at the
 * same response budget `fits` enforces (the MCP server's 30 KB; the CLI passes none), the same truncate-in-order way `match_sessions`
 * does -- reviewer's follow-up finding: a first version left `patterns` out of the budget
 * entirely, on the assumption a hackathon-scale profile's own pattern list is small by
 * construction. A profile naming many long patterns (as plausible as many long service names --
 * neither is validated for length, and both are equally the agent's own free text) let `patterns`
 * alone blow the budget regardless of how far `services` got truncated. Services are filled first,
 * in order, then patterns get whatever budget is left, also in order -- a deliberate priority, not
 * an accident of implementation order, matching this tool's existing "services are the primary
 * data" precedent (unresolved services already got their own dedicated field; patterns did not). */
export function buildValidateReport(
  resolved: ResolvedProfile,
  fits: (value: unknown) => boolean = () => true,
): ValidateProfileResponse {
  const services = resolved.services.map((service) => ({
    name: service.name,
    catalogName: service.catalogName,
  }));
  const patterns = resolved.patterns.map((pattern) => pattern.name);
  const warnings = gapWarnings(resolved);
  const counts = {
    services: resolved.services.length,
    patterns: resolved.patterns.length,
    unresolvedServices: resolved.unresolvedServices.length,
  };

  const everything = buildValidateProfileResponse(
    services,
    patterns,
    counts,
    services.length,
    patterns.length,
    false,
    warnings,
  );
  if (fits(everything)) {
    return everything;
  }

  const includedServices: CompactResolvedService[] = [];
  for (const service of services) {
    const trial = buildValidateProfileResponse(
      [...includedServices, service],
      [],
      counts,
      services.length,
      patterns.length,
      true,
      warnings,
    );
    if (!fits(trial)) {
      break;
    }
    includedServices.push(service);
  }

  const includedPatterns: string[] = [];
  for (const pattern of patterns) {
    const trial = buildValidateProfileResponse(
      includedServices,
      [...includedPatterns, pattern],
      counts,
      services.length,
      patterns.length,
      true,
      warnings,
    );
    if (!fits(trial)) {
      break;
    }
    includedPatterns.push(pattern);
  }

  return buildValidateProfileResponse(
    includedServices,
    includedPatterns,
    counts,
    services.length,
    patterns.length,
    true,
    warnings,
  );
}
