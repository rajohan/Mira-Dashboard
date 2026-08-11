import { expect, test } from "bun:test";

import { Cause, Effect, Exit, Fiber } from "effect";

import { developmentTaskNotificationLoop } from "./developmentTaskNotifications.ts";

test("development task notifications stay inert and remain interruptible", async () => {
    const fiber = Effect.runFork(developmentTaskNotificationLoop());

    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit)).toBeTrue();
    if (!Exit.isFailure(exit)) throw new Error("Expected interrupted notification fiber");
    expect(Cause.hasInterruptsOnly(exit.cause)).toBeTrue();
});
