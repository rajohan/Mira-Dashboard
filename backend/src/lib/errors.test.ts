import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asyncRoute, errorMessage } from "./errors.js";

describe("error helpers", () => {
    it("returns Error messages and stable fallbacks for unknown caught values", () => {
        const blankError = new Error("placeholder");
        blankError.message = "";

        assert.equal(errorMessage(new Error("boom"), "fallback"), "boom");
        assert.equal(errorMessage(blankError, "fallback"), "fallback");
        assert.equal(errorMessage(new Error(" ".repeat(3)), "fallback"), "fallback");
        assert.equal(errorMessage("boom", "fallback"), "fallback");
    });

    it("maps async route errors and forwards errors after headers are sent", async () => {
        const jsonCalls: unknown[] = [];
        const response = {
            headersSent: false,
            statusCode: 200,
            status(code: number) {
                response.statusCode = code;
                return response;
            },
            json(body: unknown) {
                jsonCalls.push(body);
                return response;
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

        jsonCalls.length = 0;
        const statusHandler = asyncRoute(async () => {
            throw Object.assign(new Error("conflict"), { statusCode: 409 });
        });

        await new Promise<void>((resolve) => {
            statusHandler(
                {} as never,
                response as never,
                (() => {
                    throw new Error("next should not be called");
                }) as never
            );
            setImmediate(resolve);
        });

        assert.equal(response.statusCode, 409);
        assert.deepEqual(jsonCalls, [{ error: "conflict" }]);

        for (const statusCode of [409.5, 200, 600, "409"]) {
            jsonCalls.length = 0;
            const invalidStatusHandler = asyncRoute(async () => {
                throw Object.assign(new Error("invalid status"), { statusCode });
            });

            await new Promise<void>((resolve) => {
                invalidStatusHandler(
                    {} as never,
                    response as never,
                    (() => {
                        throw new Error("next should not be called");
                    }) as never
                );
                setImmediate(resolve);
            });

            assert.equal(response.statusCode, 500);
            assert.deepEqual(jsonCalls, [{ error: "invalid status" }]);
        }

        const forwarded: unknown[] = [];
        const forwardedJsonCalls: unknown[] = [];
        const forwardedResponse = {
            headersSent: true,
            statusCode: 200,
            status(code: number) {
                forwardedResponse.statusCode = code;
                return forwardedResponse;
            },
            json(body: unknown) {
                forwardedJsonCalls.push(body);
                return forwardedResponse;
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
