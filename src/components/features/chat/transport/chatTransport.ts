import type { ChatHistoryMessage, ChatTransportAttachment } from "../chatTypes";
import type { ChatModelOption } from "../chatUtilities";
import type { ChatRuntimeEvent } from "../domain/chatState";

export interface ChatSendRequest {
    attachments?: ChatTransportAttachment[];
    idempotencyKey?: string;
    message: string;
    sessionId?: string;
    sessionKey: string;
}

export interface ChatSessionPreferences {
    fastMode?: boolean | "auto" | null;
    model?: string;
    thinkingLevel?: string | null;
    verboseLevel?: "full";
}

export interface ChatRuntimeSnapshot {
    completed: boolean;
    events: ChatRuntimeEvent[];
    throughSequence: number;
}

/** Provider-independent operations needed by the Dashboard chat feature. */
export interface ChatTransport {
    abort(sessionKey: string): Promise<void>;
    connectionGeneration: number;
    error?: string;
    history(sessionKey: string, limit: number): Promise<ChatHistoryMessage[]>;
    isConnected: boolean;
    models(): Promise<ChatModelOption[]>;
    patchSession(sessionKey: string, preferences: ChatSessionPreferences): Promise<void>;
    send(request: ChatSendRequest): Promise<{ runId?: string }>;
    snapshot(sessionKey: string): Promise<ChatRuntimeSnapshot>;
    subscribe(listener: (event: ChatRuntimeEvent) => void): () => void;
}
