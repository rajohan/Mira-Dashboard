import { expect, test } from "bun:test";

import { waitForDevelopmentStateLockReadiness } from "./developmentStateAcquisitionLock.ts";

test("accepts a readiness signal fragmented across stream chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode("LOC"));
            controller.enqueue(encoder.encode("KED\n"));
            controller.close();
        },
    });

    await waitForDevelopmentStateLockReadiness(stream);
    expect(stream.locked).toBeFalse();
});
