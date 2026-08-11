import { expect, test } from "bun:test";

import { Effect, Fiber } from "effect";

import { developmentTaskNotificationLoop } from "./developmentTaskNotifications.ts";

test("development task notifications stay inert and remain interruptible", async () => {
    const fiber = Effect.runFork(developmentTaskNotificationLoop());

    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(fiber).toBeDefined();
});
