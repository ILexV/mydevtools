import assert from "node:assert/strict";
import { test } from "node:test";
import { formatWhoisText, parseWhoisLookupSettings, whoisReferral } from "../src/tools/whois-lookup.ts";
import type { WhoisLookupResult } from "../src/scripts/local-agent.ts";

test("parseWhoisLookupSettings keeps only an in-range timeout", () => {
  assert.deepEqual(parseWhoisLookupSettings(null), { v: 1, timeoutMs: 5000 });
  assert.deepEqual(parseWhoisLookupSettings({
    v: 1,
    timeoutMs: 4000,
    query: "example.com",
    server: "whois.iana.org",
    text: "domain: EXAMPLE.COM",
  }), { v: 1, timeoutMs: 4000 });
  assert.deepEqual(parseWhoisLookupSettings({ timeoutMs: 199 }), { v: 1, timeoutMs: 5000 });
  assert.deepEqual(parseWhoisLookupSettings({ timeoutMs: 10_001 }), { v: 1, timeoutMs: 5000 });
  assert.deepEqual(parseWhoisLookupSettings({ timeoutMs: 5000.5 }), { v: 1, timeoutMs: 5000 });
});

test("formatWhoisText is the query line and then the reply", () => {
  const result: WhoisLookupResult = {
    query: "example.com",
    server: "whois.iana.org",
    port: 43,
    address: "192.0.32.59",
    status: "ok",
    elapsedMs: 80,
    truncated: false,
    text: "domain: EXAMPLE.COM\nrefer: whois.verisign-grs.com",
  };
  assert.equal(
    formatWhoisText(result),
    "example.com whois.iana.org 43 ok 192.0.32.59 80 false\ndomain: EXAMPLE.COM\nrefer: whois.verisign-grs.com",
  );
  assert.equal(
    formatWhoisText({ ...result, status: "refused", text: "", elapsedMs: 2 }),
    "example.com whois.iana.org 43 refused 192.0.32.59 2 false",
  );
});

test("whoisReferral offers the next server named in a reply, never the same one", () => {
  const iana = "% IANA WHOIS server\n\nrefer:        whois.kg\n\ndomain:       KG\n";
  assert.equal(whoisReferral(iana, "whois.iana.org"), "whois.kg");
  assert.equal(whoisReferral(iana, "WHOIS.KG"), null);
  assert.equal(whoisReferral("   Registrar WHOIS Server: whois.markmonitor.com\n", "whois.verisign-grs.com"), "whois.markmonitor.com");
  assert.equal(whoisReferral("ReferralServer:  whois://whois.ripe.net:43/\n", "whois.arin.net"), "whois.ripe.net");
  assert.equal(whoisReferral("ReferralServer:  rwhois://rwhois.example.net:4321\n", "whois.arin.net"), null);
  assert.equal(whoisReferral("Domain OGOGO.KG (ACTIVE)\n", "whois.kg"), null);
  assert.equal(whoisReferral("refer: not a host\n", "whois.iana.org"), null);
  assert.equal(whoisReferral("refer: localhost\n", "whois.iana.org"), null);
});
