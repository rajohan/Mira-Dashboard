import { expect, test } from "bun:test";

import { sha256Hex } from "./crypto.ts";

test("hashes text and equivalent UTF-8 bytes identically", () => {
    const text = "mira";
    const expected = "3c38aafb0579dafe18bb584dce2786ccaab6835245f2979af4bb7dd2b6b90775";

    expect(sha256Hex(text)).toBe(expected);
    expect(sha256Hex(new TextEncoder().encode(text))).toBe(expected);
});
