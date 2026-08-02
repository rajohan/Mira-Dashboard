import type {
    ChatSendRequest,
    ChatSendResponse,
    ChatSessionPreferences,
    OpenClawRuntimeSnapshot,
} from "../../../../../../contracts/chat/transport";
import type { ChatModelOption } from "../chatSettings";
import type { ChatHistoryMessage } from "../chatTypes";
import type { ChatRuntimeEvent } from "../domain/chatState";

export interface ChatRuntimeSnapshot {
    completed: boolean;
    events: ChatRuntimeEvent[];
    /** Stable opaque identity for one Gateway endpoint/credential replay boundary. */
    replayScope?: string;
    runtimeGeneration?: string;
    schemaVersion: OpenClawRuntimeSnapshot["schemaVersion"];
    throughSequence: number;
}

/** Provider-independent operations needed by the Dashboard chat feature. */
export interface ChatTransport {
    abort: (sessionKey: string) => Promise<void>;
    compact: (sessionKey: string) => Promise<void>;
    connectionGeneration: number;
    error?: string;
    history: (sessionKey: string, limit: number) => Promise<ChatHistoryMessage[]>;
    isConnected: boolean;
    models: () => Promise<ChatModelOption[]>;
    patchSession: (
        sessionKey: string,
        preferences: ChatSessionPreferences
    ) => Promise<void>;
    send: (request: ChatSendRequest) => Promise<ChatSendResponse>;
    snapshot: (sessionKey: string) => Promise<ChatRuntimeSnapshot>;
    /** Delivers every event derived from one provider envelope as one atomic batch. */
    subscribe: (listener: (events: ChatRuntimeEvent[]) => void) => () => void;
}
