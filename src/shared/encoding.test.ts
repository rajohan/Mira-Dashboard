import { expect, test } from "bun:test";

import { utf8ByteLength } from "./encoding.ts";

test("counts encoded UTF-8 bytes instead of UTF-16 code units", () => {
    expect(utf8ByteLength("plain")).toBe(5);
    expect(utf8ByteLength("blå")).toBe(4);
    expect(utf8ByteLength("👩‍💻")).toBe(11);
    expect(utf8ByteLength("\uD800")).toBe(3);
    expect(utf8ByteLength("\uDC00")).toBe(3);
});
