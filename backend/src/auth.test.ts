import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hashPassword, isLoopbackRequest, verifyPassword } from "./auth.js";

describe("auth helpers", () => {
    it("hashes passwords with unique salts and verifies only the matching secret", () => {
        const firstHash = hashPassword("correct horse battery staple");
        const secondHash = hashPassword("correct horse battery staple");

        assert.match(firstHash, /^scrypt:[\da-f]+:[\da-f]+$/);
        assert.notEqual(firstHash, secondHash);
        assert.equal(verifyPassword("correct horse battery staple", firstHash), true);
        assert.equal(verifyPassword("wrong password", firstHash), false);
    });

    it("rejects malformed or incompatible password hashes", () => {
        assert.equal(verifyPassword("secret", ""), false);
        assert.equal(verifyPassword("secret", "bcrypt:salt:hash"), false);
        assert.equal(verifyPassword("secret", "scrypt:salt:abcd"), false);
    });

    it("recognizes loopback requests only", () => {
        assert.equal(
            isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" } } as never),
            true
        );
        assert.equal(
            isLoopbackRequest({ socket: { remoteAddress: "::1" } } as never),
            true
        );
        assert.equal(
            isLoopbackRequest({ socket: { remoteAddress: "::ffff:127.0.0.1" } } as never),
            true
        );
        assert.equal(
            isLoopbackRequest({ socket: { remoteAddress: "10.0.0.5" } } as never),
            false
        );
    });
});
