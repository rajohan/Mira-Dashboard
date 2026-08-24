import { expect, test } from "bun:test";

import { areSha256DigestsEqual, randomHex, sha256Hex } from "./crypto.ts";

test("hashes text and equivalent UTF-8 bytes identically", () => {
    const text = "mira";
    const expected = "3c38aafb0579dafe18bb584dce2786ccaab6835245f2979af4bb7dd2b6b90775";

    expect(sha256Hex(text)).toBe(expected);
    expect(sha256Hex(new TextEncoder().encode(text))).toBe(expected);
});

test("generates bounded lowercase random hex", () => {
    const value = randomHex(16);

    expect(value).toMatch(/^[0-9a-f]{32}$/u);
    expect(() => randomHex(0)).toThrow("Random byte length is invalid");
    expect(() => randomHex(1025)).toThrow("Random byte length is invalid");
});

test("compares only canonical SHA-256 digests", () => {
    const digest = sha256Hex("mira");

    expect(areSha256DigestsEqual(digest, digest)).toBe(true);
    expect(areSha256DigestsEqual(digest, sha256Hex("dashboard"))).toBe(false);
    expect(areSha256DigestsEqual(digest, digest.toUpperCase())).toBe(false);
    expect(areSha256DigestsEqual(digest, "not-a-digest")).toBe(false);
});
