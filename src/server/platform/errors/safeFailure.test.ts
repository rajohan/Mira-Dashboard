import { expect, test } from "bun:test";

import { Cause, Data } from "effect";

import { describeSafeFailure } from "./safeFailure.ts";

class ExpectedFailure extends Data.TaggedError("ApplicationListenerStopError")<{
    readonly cause: unknown;
    readonly operation: "read";
}> {}

test("describes errors without messages, stacks, causes, or arbitrary fields", () => {
    const sentinel = "never-emit-this-secret";
    const failure = new ExpectedFailure({
        cause: new Error(sentinel),
        operation: "read",
    });
    Object.defineProperty(failure, "code", {
        enumerable: true,
        value: "SAFE_CODE",
    });
    Object.defineProperty(failure, "payload", {
        enumerable: true,
        value: sentinel,
    });

    const descriptor = describeSafeFailure(failure);
    expect(descriptor).toMatchObject({
        kind: "tagged",
        name: "ApplicationListenerStopError",
        tag: "ApplicationListenerStopError",
    });
    expect(descriptor.fingerprint).toMatch(/^[0-9a-f]{24}$/u);
    expect(JSON.stringify(descriptor)).not.toContain(sentinel);
    expect(Object.isFrozen(descriptor)).toBe(true);
});

test("treats Effect causes and forged cause-like values as opaque", () => {
    const sentinel = "cause-secret";
    const expected = Cause.fail(new Error(sentinel));
    const defect = Cause.die(sentinel);
    let callbackCalls = 0;
    const forgedCause = {
        "~effect/Cause": "~effect/Cause",
        reasons: {
            some() {
                callbackCalls += 1;
                throw new Error(sentinel);
            },
        },
    };

    for (const failure of [Cause.combine(expected, defect), forgedCause]) {
        const descriptor = describeSafeFailure(failure);
        expect(descriptor).toMatchObject({ kind: "unknown" });
        expect(JSON.stringify(descriptor)).not.toContain(sentinel);
    }
    expect(callbackCalls).toBe(0);
});

test("does not invoke getters or expose unregistered tagged values", () => {
    let getterCalls = 0;
    const value = Object.defineProperty({ _tag: "SafeTag" }, "operation", {
        enumerable: true,
        get() {
            getterCalls += 1;
            return "unsafe";
        },
    });

    expect(describeSafeFailure(value)).toMatchObject({ kind: "unknown" });
    expect(getterCalls).toBe(0);
});

test("does not invoke an Error name accessor", () => {
    let getterCalls = 0;
    const failure = Object.defineProperty(new Error("secret"), "name", {
        get() {
            getterCalls += 1;
            throw new Error("name accessor secret");
        },
    });

    expect(describeSafeFailure(failure)).toMatchObject({
        kind: "error",
        name: "Error",
    });
    expect(getterCalls).toBe(0);
});

test("fails closed for hostile proxy traps", () => {
    let trapCalls = 0;
    const hostile = new Proxy(
        {},
        {
            getOwnPropertyDescriptor() {
                trapCalls += 1;
                throw new Error("descriptor trap secret");
            },
            getPrototypeOf() {
                trapCalls += 1;
                throw new Error("prototype trap secret");
            },
        }
    );

    const descriptor = describeSafeFailure(hostile);
    expect(descriptor).toMatchObject({ kind: "unknown" });
    expect(JSON.stringify(descriptor)).not.toContain("trap secret");
    expect(trapCalls).toBe(0);
});
