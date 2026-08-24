/** The same idempotency key or client run id was reused for a different intent. */
export class ChatAdmissionConflictError extends Error {
    public constructor() {
        super("Chat admission conflicts with an existing durable intent");
        this.name = "ChatAdmissionConflictError";
    }
}

/** Per-session or process-wide active-run admission is full. */
export class ChatAdmissionCapacityError extends Error {
    public readonly scope: "process" | "session";

    public constructor(scope: "process" | "session") {
        super(`Chat ${scope} admission capacity is full`);
        this.name = "ChatAdmissionCapacityError";
        this.scope = scope;
    }
}

/** The provider transcript is absent or behind a durable control/reconciliation fence. */
export class ChatTranscriptUnavailableError extends Error {
    public constructor() {
        super("Chat transcript is not available for runtime mutation");
        this.name = "ChatTranscriptUnavailableError";
    }
}

export class ChatRunNotFoundError extends Error {
    public constructor() {
        super("Chat run was not found");
        this.name = "ChatRunNotFoundError";
    }
}

/** A caller attempted an impossible or stale state-machine transition. */
export class ChatRunTransitionError extends Error {
    public constructor(message = "Chat run transition is invalid") {
        super(message);
        this.name = "ChatRunTransitionError";
    }
}

/** A provider sequence was reused with different content or partially overlapped. */
export class ChatProviderSequenceConflictError extends Error {
    public constructor() {
        super("Chat provider event sequence overlaps durable history");
        this.name = "ChatProviderSequenceConflictError";
    }
}

/** A provider frame arrived after one or more shared run-sequence frames were lost. */
export class ChatProviderSequenceGapError extends Error {
    public readonly expected: number;
    public readonly received: number;

    public constructor(expected: number, received: number) {
        super(`Chat provider event sequence jumped from ${expected} to ${received}`);
        this.name = "ChatProviderSequenceGapError";
        this.expected = expected;
        this.received = received;
    }
}

/** The bounded per-run event journal or projection budget is exhausted. */
export class ChatRunBudgetExceededError extends Error {
    public constructor() {
        super("Chat run journal exceeds its durable budget");
        this.name = "ChatRunBudgetExceededError";
    }
}
