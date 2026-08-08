import { describe, expect, test } from "bun:test";

let fileReaderResult: string | undefined;
let nestedTimerCompleted = false;

describe("browser test teardown", () => {
    test("leaves HappyDOM-owned nested zero-delay work for teardown to drain", () => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
            if (typeof reader.result === "string") fileReaderResult = reader.result;
        });
        // oxlint-disable-next-line unicorn/prefer-blob-reading-methods -- Exercises HappyDOM's internal nested timer path.
        reader.readAsText(new Blob(["nested HappyDOM timer"]));
        expect(fileReaderResult).toBeUndefined();
    });

    test("finishes HappyDOM-owned work before the following test", async () => {
        expect(fileReaderResult).toBe("nested HappyDOM timer");
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    });

    test("leaves arbitrary nested zero-delay work for teardown to drain", () => {
        const schedule = globalThis.setTimeout.bind(globalThis);
        schedule(() => {
            schedule(() => {
                schedule(() => {
                    nestedTimerCompleted = true;
                }, 0);
            }, 0);
        }, 0);
        expect(true).toBeTrue();
    });

    test("keeps zero-delay timers usable in the following test", async () => {
        expect(nestedTimerCompleted).toBeTrue();
        let completed = false;
        await new Promise<void>((resolve) => {
            globalThis.setTimeout(() => {
                completed = true;
                resolve();
            }, 0);
        });
        expect(completed).toBeTrue();
    });
});
