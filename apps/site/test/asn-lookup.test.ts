import assert from "node:assert/strict";
import test from "node:test";
import type { AsnLookupResult } from "../src/scripts/local-agent.ts";
import { asnQueryLooksValid, formatAsnText } from "../src/tools/asn-lookup.ts";

test("asnQueryLooksValid accepts one address or one CIDR", () => {
  for (const query of ["1.1.1.1", "1.1.1.1/24", "8.8.8.8", "::1", "2001:db8::1", "::ffff:1.1.1.1", "::ffff:1.1.1.1/128", "0.0.0.0/0"]) {
    assert.equal(asnQueryLooksValid(query), true, query);
  }
});

test("asnQueryLooksValid rejects a name, a URL, a range and a list", () => {
  for (const query of ["", "example.com", "http://1.1.1.1", "1.1.1.1-1.1.1.2", "1.1.1.1,8.8.8.8", "fe80::1%eth0", "1.1.1.1/24/32", "1.1.1.1/", "01.1.1.1", "1.1.1.1/33"]) {
    assert.equal(asnQueryLooksValid(query), false, query);
  }
});

test("formatAsnText keeps the prefix, the ASN and whether it covers", () => {
  const result: AsnLookupResult = {
    query: "1.1.1.1",
    address: "1.1.1.1",
    prefix: "1.1.1.0/24",
    asn: 13335,
    name: "CLOUDFLARENET",
    status: "found",
    covers: true,
  };
  assert.equal(
    formatAsnText(result),
    "1.1.1.1 1.1.1.1 1.1.1.0/24 13335 CLOUDFLARENET found true",
  );
  const reserved: AsnLookupResult = {
    query: "127.0.0.1",
    address: "127.0.0.1",
    prefix: null,
    asn: null,
    name: "",
    status: "reserved",
    covers: false,
  };
  assert.equal(formatAsnText(reserved), "127.0.0.1 127.0.0.1    reserved false");
});
