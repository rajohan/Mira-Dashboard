import { Effect } from "effect";

const oneDayMs = 24 * 60 * 60 * 1000;

// A real timer handle keeps the fixture alive until the owner sends SIGTERM or SIGKILL.
await Effect.runPromise(Effect.sleep(oneDayMs));
