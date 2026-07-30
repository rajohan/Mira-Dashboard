import type { OpenClawRuntimeSnapshot } from "../../../contracts/chat.ts";

/** Maximum number of persisted runtime sessions retained per Gateway scope. */
export const MAX_CHAT_RUNTIME_SESSIONS = 50;

/** Debounce applied to non-terminal runtime snapshot writes. */
export const OPENCLAW_CHAT_PERSIST_DEBOUNCE_MS = 250;

/** Storage boundary for the latest bounded replay of each chat session. */
export interface OpenClawChatSnapshotStore {
    clear(): void;
    delete(sessionKey: string): void;
    keys(): string[];
    load(sessionKey: string): OpenClawRuntimeSnapshot | undefined;
    maximumSequence(): number;
    promote(
        sourceSessionKey: string,
        canonicalSessionKey: string,
        sourceSnapshot: OpenClawRuntimeSnapshot,
        canonicalSnapshot: OpenClawRuntimeSnapshot
    ): void;
    save(sessionKey: string, snapshot: OpenClawRuntimeSnapshot): void;
}
