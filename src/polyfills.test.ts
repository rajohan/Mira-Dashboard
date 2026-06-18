import { describe, expect, it, jest } from "bun:test";

import { installRandomUUIDPolyfill } from "./utils/randomUuidPolyfill";

describe("polyfills", () => {
    it("keeps an existing browser randomUUID implementation", () => {
        const randomUUID = jest.fn(
            () =>
                "11111111-1111-4111-8111-111111111111" as ReturnType<Crypto["randomUUID"]>
        );

        Object.defineProperty(window, "crypto", {
            configurable: true,
            value: { randomUUID },
        });

        installRandomUUIDPolyfill();

        expect(window.crypto.randomUUID()).toBe("11111111-1111-4111-8111-111111111111");
        expect(randomUUID).toHaveBeenCalledTimes(1);
    });

    it("installs randomUUID when crypto exists without it", () => {
        Object.defineProperty(window, "crypto", {
            configurable: true,
            value: {},
        });

        installRandomUUIDPolyfill();

        expect(window.crypto.randomUUID()).toMatch(
            /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/u
        );
    });

    it("installs a crypto container when it is missing", () => {
        Object.defineProperty(window, "crypto", {
            configurable: true,
            value: undefined,
        });

        installRandomUUIDPolyfill();

        expect(window.crypto.randomUUID()).toMatch(
            /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/u
        );
    });
});
