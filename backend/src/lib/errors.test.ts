import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asyncRoute, errorMessage } from "./errors.js";

describe("error helpers", () => {
    it("returns Error messages and stable fallbacks for unknown caught values", () => {
        const blankError = new Error("placeholder");
        blankError.message = "";

        assert.equal(errorMessage(new Error("boom"), "fallback"), "boom");
        assert.equal(errorMessage(blankError, "fallback"), "fallback");
        assert.equal(errorMessage(new Error("   "), "fallback"), "fallback");
        assert.equal(errorMessage("boom", "fallback"), "fallback");
    });

    it("maps async route errors and forwards errors after headers are sent", async () => {
        const jsonCalls: unknown[] = [];
        const response = {
            headersSent: false,
            statusCode: 200,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(body: unknown) {
                jsonCalls.push(body);
                return this;
            },
        };

        const handler = asyncRoute(
            async () => {
                throw "bad";
            },
            { fallback: "fallback" }
        );

        handler(
            {} as never,
            response as never,
            (() => {
                throw new Error("next should not be called");
            }) as never
        );
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(response.statusCode, 500);
        assert.deepEqual(jsonCalls, [{ error: "fallback" }]);

        const forwarded: unknown[] = [];
        const forwardedJsonCalls: unknown[] = [];
        const forwardedResponse = {
            headersSent: true,
            statusCode: 200,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(body: unknown) {
                forwardedJsonCalls.push(body);
                return this;
            },
        };
        const forwardHandler = asyncRoute(async () => {
            throw new Error("after headers");
        }, {});

        forwardHandler(
            {} as never,
            forwardedResponse as never,
            ((error: unknown) => forwarded.push(error)) as never
        );
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal((forwarded[0] as Error).message, "after headers");
        assert.deepEqual(forwardedJsonCalls, []);
        assert.equal(forwardedResponse.statusCode, 200);
    });
});
