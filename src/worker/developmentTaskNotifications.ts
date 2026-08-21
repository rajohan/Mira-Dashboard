import { Effect } from "effect";

/**
 * Keeps the worker's notification fiber lifecycle-compatible without ever reading
 * a queue or sending isolated development task events to the real Gateway.
 * @returns A fiber that remains idle until the worker runtime interrupts it.
 */
export function developmentTaskNotificationLoop(): Effect.Effect<never> {
    return Effect.never;
}
