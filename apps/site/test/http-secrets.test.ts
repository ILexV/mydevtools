import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSecretName,
  isSecretValue,
  parseSecretHosts,
  secretPlaceholder,
  suggestedSecretHost,
} from "../src/tools/http-secrets.ts";

test("secret names follow the agent rule", () => {
  for (const name of ["API_TOKEN", "a", "stripe.live-key", "x".repeat(64)]) assert.equal(isSecretName(name), true, name);
  for (const name of ["", "_token", "-a", "with space", "ключ", "x".repeat(65), "a{b}"]) assert.equal(isSecretName(name), false, name);
  assert.equal(secretPlaceholder("API_TOKEN"), "{{secret:API_TOKEN}}");
});

test("secret values are single-line and at most 8 KiB of UTF-8", () => {
  assert.equal(isSecretValue("Bearer abc.def"), true);
  assert.equal(isSecretValue("пароль"), true);
  assert.equal(isSecretValue(""), false);
  assert.equal(isSecretValue("a\nb"), false);
  assert.equal(isSecretValue("a\tb"), false);
  assert.equal(isSecretValue("a".repeat(8192)), true);
  assert.equal(isSecretValue("ж".repeat(4097)), false);
});

test("host lists are split, lowercased and deduplicated", () => {
  assert.deepEqual(parseSecretHosts(" API.example.com, *.example.com\n127.0.0.1;[::1] api.example.com "),
    ["api.example.com", "*.example.com", "127.0.0.1", "[::1]"]);
  assert.deepEqual(parseSecretHosts("example.com."), ["example.com"]);
  assert.equal(parseSecretHosts(""), null);
  assert.equal(parseSecretHosts(" , "), null);
  for (const bad of ["https://api.example.com", "api.example.com:443", "api.example.com/v1", "user@host", "*.com",
    "*", "*.10.0.0.1", "a*.example.com", "ok.example.com, bad_host"]) {
    assert.equal(parseSecretHosts(bad), null, bad);
  }
  assert.equal(parseSecretHosts(Array.from({ length: 17 }, (_, i) => `h${i}.example.com`).join(",")), null);
});

test("the open request's host is suggested for a new secret", () => {
  assert.equal(suggestedSecretHost("https://API.example.com:8443/v1?x=1"), "api.example.com");
  assert.equal(suggestedSecretHost("http://[::1]:3000/"), "[::1]");
  assert.equal(suggestedSecretHost("ftp://example.com/"), "");
  assert.equal(suggestedSecretHost("not a url"), "");
});
