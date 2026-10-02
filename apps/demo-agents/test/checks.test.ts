import { describe, expect, it, vi } from "vitest";
import { checkEmail, checkMailDomain, isDisposableDomain, isRoleAddress, parseEmail, type MailResolver } from "../src/emailVerifier/checks.js";

const dnsError = (code: string) => Object.assign(new Error(code), { code });

type Answer<T> = T | Error;
function fakeResolver(answers: { mx?: Answer<{ exchange: string; priority: number }[]>; a?: Answer<string[]>; aaaa?: Answer<string[]> }) {
  const answer = async <T>(a: Answer<T> | undefined): Promise<T> => {
    if (a === undefined) throw dnsError("ENODATA");
    if (a instanceof Error) throw a;
    return a;
  };
  const resolver: MailResolver = {
    resolveMx: vi.fn(() => answer(answers.mx)),
    resolve4: vi.fn(() => answer(answers.a)),
    resolve6: vi.fn(() => answer(answers.aaaa)),
  };
  return resolver;
}

describe("parseEmail", () => {
  it("accepts a plain address and lowercases the domain only", () => {
    expect(parseEmail("  Jane.Doe+tag@Example.COM ")).toEqual({ ok: true, email: { local: "Jane.Doe+tag", domain: "example.com" } });
  });

  it("converts internationalized domains to punycode", () => {
    expect(parseEmail("user@bücher.de")).toEqual({ ok: true, email: { local: "user", domain: "xn--bcher-kva.de" } });
  });

  it.for([
    ["", "empty"],
    ["no-at-sign", "must be local-part@domain"],
    ["@example.com", "must be local-part@domain"],
    ["user@", "must be local-part@domain"],
    ['"quoted"@example.com', "quoted local parts are not supported"],
    ["a@b@example.com", "quoted local parts are not supported"],
    ["user@[127.0.0.1]", "address literals ([1.2.3.4]) are not supported"],
    ["user..name@example.com", "local part has characters that are not allowed"],
    [".user@example.com", "local part has characters that are not allowed"],
    ["user name@example.com", "local part has characters that are not allowed"],
    ["user@localhost", "invalid domain"],
    ["user@-bad.com", "invalid domain"],
    ["user@exa_mple.com", "invalid domain"],
    ["user@example.123", "invalid domain"],
    ["user@1.2.3.4", "top-level domain cannot be numeric"],
    [`${"a".repeat(65)}@example.com`, "local part longer than 64 characters"],
    [`a@${"b".repeat(250)}.com`, "longer than 254 characters"],
  ] as const)("rejects %j (%s)", ([input, problem]) => {
    expect(parseEmail(input)).toEqual({ ok: false, problem });
  });
});

describe("isRoleAddress", () => {
  it("matches role local parts, ignoring case and +tags", () => {
    expect(isRoleAddress("info")).toBe(true);
    expect(isRoleAddress("Support+billing")).toBe(true);
    expect(isRoleAddress("no-reply")).toBe(true);
    expect(isRoleAddress("jane")).toBe(false);
    expect(isRoleAddress("information")).toBe(false);
  });
});

describe("isDisposableDomain", () => {
  const list = new Set(["mailinator.com"]);

  it("matches the domain and its subdomains", () => {
    expect(isDisposableDomain("mailinator.com", list)).toBe(true);
    expect(isDisposableDomain("eu.mailinator.com", list)).toBe(true);
    expect(isDisposableDomain("notmailinator.com", list)).toBe(false);
    expect(isDisposableDomain("example.com", list)).toBe(false);
  });

  it("uses the bundled blocklist by default", () => {
    expect(isDisposableDomain("mailinator.com")).toBe(true);
    expect(isDisposableDomain("gmail.com")).toBe(false);
  });
});

describe("checkMailDomain", () => {
  it("returns MX hosts by priority", async () => {
    const r = fakeResolver({
      mx: [
        { exchange: "B.mx.example.com", priority: 20 },
        { exchange: "a.mx.example.com", priority: 10 },
      ],
    });
    expect(await checkMailDomain(r, "example.com")).toEqual({ acceptsMail: true, mx: ["a.mx.example.com", "b.mx.example.com"], implicitMx: false });
  });

  it("treats an RFC 7505 null MX as not accepting mail", async () => {
    expect(await checkMailDomain(fakeResolver({ mx: [{ exchange: "", priority: 0 }] }), "example.com")).toEqual({
      acceptsMail: false,
      reason: "null_mx",
    });
  });

  it("falls back to A/AAAA when there is no MX record", async () => {
    expect(await checkMailDomain(fakeResolver({ a: ["203.0.113.5"] }), "example.com")).toEqual({ acceptsMail: true, mx: [], implicitMx: true });
    expect(await checkMailDomain(fakeResolver({ aaaa: ["2001:db8::1"] }), "example.com")).toEqual({ acceptsMail: true, mx: [], implicitMx: true });
  });

  it("reports a domain with no mail records", async () => {
    expect(await checkMailDomain(fakeResolver({}), "example.com")).toEqual({ acceptsMail: false, reason: "no_mail_records" });
  });

  it("reports a domain that does not exist", async () => {
    expect(await checkMailDomain(fakeResolver({ mx: dnsError("ENOTFOUND") }), "nope.example")).toEqual({
      acceptsMail: false,
      reason: "no_such_domain",
    });
  });

  it("reports DNS failures as unknown, not as a failing domain", async () => {
    expect(await checkMailDomain(fakeResolver({ mx: dnsError("ETIMEOUT") }), "example.com")).toEqual({ acceptsMail: null, reason: "dns_error" });
    expect(await checkMailDomain(fakeResolver({ a: dnsError("ESERVFAIL") }), "example.com")).toEqual({ acceptsMail: null, reason: "dns_error" });
  });
});

describe("checkEmail", () => {
  const mx = fakeResolver({ mx: [{ exchange: "mx.example.com", priority: 10 }] });

  it("passes a well-formed address on a mail domain", async () => {
    const result = await checkEmail("jane@example.com", mx);
    expect(result).toEqual({
      normalized: "jane@example.com",
      status: "pass",
      reasons: [],
      checks: {
        syntax: { ok: true },
        domain: { acceptsMail: true, mx: ["mx.example.com"], implicitMx: false },
        disposable: false,
        roleAddress: false,
        mailbox: "not_checked",
      },
    });
  });

  it("flags role addresses and disposable domains as risky", async () => {
    expect((await checkEmail("info@example.com", mx)).status).toBe("risky");
    const disposable = await checkEmail("jane@mailinator.com", mx);
    expect(disposable.status).toBe("risky");
    expect(disposable.reasons).toEqual(["disposable_domain"]);
  });

  it("fails bad syntax without any DNS lookup", async () => {
    const r = fakeResolver({});
    const result = await checkEmail("not an email", r);
    expect(result.status).toBe("fail");
    expect(result.reasons).toEqual(["invalid_syntax"]);
    expect(result.normalized).toBeNull();
    expect(r.resolveMx).not.toHaveBeenCalled();
  });

  it("fails a domain that takes no mail, and is unknown when DNS fails", async () => {
    expect((await checkEmail("jane@example.com", fakeResolver({ mx: dnsError("ENOTFOUND") }))).status).toBe("fail");
    const unknown = await checkEmail("info@example.com", fakeResolver({ mx: dnsError("ETIMEOUT") }));
    expect(unknown.status).toBe("unknown");
    expect(unknown.reasons).toEqual(["dns_error", "role_address"]);
  });
});
