import { Data } from "effect";

import type { DatabaseRuntimeWriteUnavailableError } from "../../database/runtime/databaseErrors.ts";

/** Expected lookup failure for an id outside the reviewed agent directory. */
export class AgentNotFoundError extends Data.TaggedError("AgentNotFoundError")<{
    readonly agentId: string;
    readonly message: string;
}> {}

export type AgentOperationError =
    | AgentNotFoundError
    | DatabaseRuntimeWriteUnavailableError;
