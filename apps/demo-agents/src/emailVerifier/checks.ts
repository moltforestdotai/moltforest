/**
 * Email checks sold by the email-verifier demo agent: syntax, whether the
 * domain accepts mail (MX, or the RFC 5321 A/AAAA fallback), disposable
 * domains and role addresses.
 *
 * The mailbox itself is never probed over SMTP: probing from the shared server
 * risks getting its IP blacklisted. Results say so (`mailbox: "not_checked"`).
 *
 * Addresses are personal data. Nothing here stores or logs them.
 */
import { Resolver } from "node:dns/promises";
import { domainToASCII } from "node:url";
import { disposableEmailBlocklistSet } from "disposable-email-domains-js";

export type CheckStatus = "pass" | "risky" | "fail" | "unknown";

export type CheckReason =
  | "invalid_syntax"
  | "no_such_domain"
  | "null_mx"
  | "no_mail_records"
  | "dns_error"
  | "disposable_domain"
  | "role_address";

export interface EmailCheckResult {
  /** The address with its domain lowercased and in ASCII (punycode); null when the syntax is invalid. */
  normalized: string | null;
  /**
   * pass: well-formed, the domain accepts mail, not disposable, not a role address.
   * risky: deliverable domain, but disposable or a role address.
   * fail: malformed, or the domain cannot receive mail.
   * unknown: DNS did not answer in time.
   */
  status: CheckStatus;
  reasons: CheckReason[];
  checks: {
    syntax: { ok: boolean; problem?: string };
    domain: {
      /** null when DNS failed or was skipped. */
      acceptsMail: boolean | null;
      /** Mail exchangers by priority (at most 5). */
      mx: string[];
      /** True when there is no MX record and mail would go to the A/AAAA address. */
      implicitMx: boolean;
    };
    disposable: boolean;
    roleAddress: boolean;
    mailbox: "not_checked";
  };
}

export const MAX_EMAIL_LENGTH = 254;

// RFC 5322 dot-atom local part (ASCII only; quoted local parts are not supported).
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const ROLE_LOCAL_PARTS = new Set([
  "abuse", "accounting", "accounts", "admin", "administrator", "billing", "careers", "compliance",
  "contact", "customerservice", "dev", "devops", "enquiries", "feedback", "finance", "hello", "help",
  "helpdesk", "hostmaster", "hr", "info", "inquiries", "it", "jobs", "legal", "mail", "mailer-daemon",
  "marketing", "media", "news", "newsletter", "no-reply", "noc", "noreply", "office", "orders",
  "postmaster", "press", "privacy", "root", "sales", "security", "service", "support", "sysadmin",
  "team", "tech", "webmaster",
]);

export interface ParsedEmail {
  local: string;
  /** Lowercase ASCII (punycode) domain. */
  domain: string;
}

export function parseEmail(input: string): { ok: true; email: ParsedEmail } | { ok: false; problem: string } {
  const email = input.trim();
  if (email.length === 0) return { ok: false, problem: "empty" };
  if (email.length > MAX_EMAIL_LENGTH) return { ok: false, problem: `longer than ${MAX_EMAIL_LENGTH} characters` };
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return { ok: false, problem: "must be local-part@domain" };
  const local = email.slice(0, at);
  const rawDomain = email.slice(at + 1);
  if (local.includes("@") || local.startsWith('"')) return { ok: false, problem: "quoted local parts are not supported" };
  if (local.length > 64) return { ok: false, problem: "local part longer than 64 characters" };
  if (!LOCAL_PART.test(local)) return { ok: false, problem: "local part has characters that are not allowed" };
  if (rawDomain.startsWith("[")) return { ok: false, problem: "address literals ([1.2.3.4]) are not supported" };

  const domain = domainToASCII(rawDomain.toLowerCase());
  if (!domain || domain.length > 253) return { ok: false, problem: "invalid domain" };
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => DNS_LABEL.test(l))) return { ok: false, problem: "invalid domain" };
  if (/^[0-9]+$/.test(labels.at(-1)!)) return { ok: false, problem: "top-level domain cannot be numeric" };
  return { ok: true, email: { local, domain } };
}

export function isRoleAddress(local: string): boolean {
  const base = local.toLowerCase().split("+")[0]!;
  return ROLE_LOCAL_PARTS.has(base);
}

let disposableSet: Set<string> | undefined;

/** True when the domain, or any parent domain, is on the disposable-email blocklist. */
export function isDisposableDomain(domain: string, blocklist: Set<string> = (disposableSet ??= disposableEmailBlocklistSet())): boolean {
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (blocklist.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

/** The subset of node:dns/promises the checks need; injectable for tests. */
export interface MailResolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

export function createResolver(timeoutMs: number): MailResolver {
  return new Resolver({ timeout: timeoutMs, tries: 2 });
}

type DomainOutcome =
  | { acceptsMail: true; mx: string[]; implicitMx: boolean }
  | { acceptsMail: false; reason: "no_such_domain" | "null_mx" | "no_mail_records" }
  | { acceptsMail: null; reason: "dns_error" };

const dnsCode = (err: unknown) => (err as { code?: unknown } | null)?.code;
const isNoData = (err: unknown) => dnsCode(err) === "ENODATA";
const isNxDomain = (err: unknown) => dnsCode(err) === "ENOTFOUND";

/** Has any A or AAAA record; false when neither exists. Other DNS errors are thrown. */
async function hasAddress(resolver: MailResolver, domain: string): Promise<boolean> {
  for (const lookup of [() => resolver.resolve4(domain), () => resolver.resolve6(domain)]) {
    try {
      if ((await lookup()).length > 0) return true;
    } catch (err) {
      if (!isNoData(err) && !isNxDomain(err)) throw err;
    }
  }
  return false;
}

export async function checkMailDomain(resolver: MailResolver, domain: string): Promise<DomainOutcome> {
  try {
    const records = await resolver.resolveMx(domain);
    // RFC 7505 null MX: a single record with an empty exchange says "this domain takes no mail".
    if (records.length === 1 && (records[0]!.exchange === "" || records[0]!.exchange === ".")) {
      return { acceptsMail: false, reason: "null_mx" };
    }
    if (records.length > 0) {
      const mx = [...records].sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase()).slice(0, 5);
      return { acceptsMail: true, mx, implicitMx: false };
    }
  } catch (err) {
    if (isNxDomain(err)) return { acceptsMail: false, reason: "no_such_domain" };
    if (!isNoData(err)) return { acceptsMail: null, reason: "dns_error" };
  }
  // No MX record: RFC 5321 §5.1 falls back to the domain's own address.
  try {
    return (await hasAddress(resolver, domain))
      ? { acceptsMail: true, mx: [], implicitMx: true }
      : { acceptsMail: false, reason: "no_mail_records" };
  } catch {
    return { acceptsMail: null, reason: "dns_error" };
  }
}

export async function checkEmail(input: string, resolver: MailResolver): Promise<EmailCheckResult> {
  const parsed = parseEmail(input);
  if (!parsed.ok) {
    return {
      normalized: null,
      status: "fail",
      reasons: ["invalid_syntax"],
      checks: {
        syntax: { ok: false, problem: parsed.problem },
        domain: { acceptsMail: null, mx: [], implicitMx: false },
        disposable: false,
        roleAddress: false,
        mailbox: "not_checked",
      },
    };
  }

  const { local, domain } = parsed.email;
  const disposable = isDisposableDomain(domain);
  const roleAddress = isRoleAddress(local);
  const outcome = await checkMailDomain(resolver, domain);

  const reasons: CheckReason[] = [];
  if (outcome.acceptsMail !== true) reasons.push(outcome.reason);
  if (disposable) reasons.push("disposable_domain");
  if (roleAddress) reasons.push("role_address");

  const status: CheckStatus =
    outcome.acceptsMail === false ? "fail" : outcome.acceptsMail === null ? "unknown" : disposable || roleAddress ? "risky" : "pass";

  return {
    normalized: `${local}@${domain}`,
    status,
    reasons,
    checks: {
      syntax: { ok: true },
      domain:
        outcome.acceptsMail === true
          ? { acceptsMail: true, mx: outcome.mx, implicitMx: outcome.implicitMx }
          : { acceptsMail: outcome.acceptsMail, mx: [], implicitMx: false },
      disposable,
      roleAddress,
      mailbox: "not_checked",
    },
  };
}
