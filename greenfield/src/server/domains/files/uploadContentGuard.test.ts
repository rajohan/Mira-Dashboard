import { describe, expect, test } from "bun:test";

import { CONFIG_REDACTION_SENTINEL } from "../../../shared/configRedaction.ts";
import { WorkspaceFileError } from "./errors.ts";
import { rejectRedactionSentinel } from "./uploadContentGuard.ts";

const encoder = new TextEncoder();

describe("upload content guard", () => {
    test("cancels and unlocks the source after a split sentinel", async () => {
        let cancellationReason: unknown;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                const splitAt = Math.floor(CONFIG_REDACTION_SENTINEL.length / 2);
                controller.enqueue(
                    encoder.encode(CONFIG_REDACTION_SENTINEL.slice(0, splitAt))
                );
                controller.enqueue(
                    encoder.encode(CONFIG_REDACTION_SENTINEL.slice(splitAt))
                );
            },
            cancel(reason) {
                cancellationReason = reason;
            },
        });

        const reader = rejectRedactionSentinel(body).getReader();
        const firstResult = await reader.read();
        expect(firstResult.done).toBe(false);
        let failure: unknown;
        try {
            await reader.read();
        } catch (error) {
            failure = error;
        }
        expect(failure).toMatchObject({
            reason: "invalid-input",
        });
        expect(cancellationReason).toBeInstanceOf(WorkspaceFileError);
        expect(body.locked).toBe(false);
    });

    test("propagates downstream cancellation and releases the source lock", async () => {
        const reason = new Error("consumer stopped");
        let cancellationReason: unknown;
        const body = new ReadableStream<Uint8Array>({
            cancel(value) {
                cancellationReason = value;
            },
        });

        await rejectRedactionSentinel(body).cancel(reason);

        expect(cancellationReason).toBe(reason);
        expect(body.locked).toBe(false);
    });

    test("propagates source failures and releases the source lock", async () => {
        const failure = new Error("source failed");
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.error(failure);
            },
        });

        let receivedFailure: unknown;
        try {
            await rejectRedactionSentinel(body).getReader().read();
        } catch (error) {
            receivedFailure = error;
        }
        expect(receivedFailure).toBe(failure);
        expect(body.locked).toBe(false);
    });
});
