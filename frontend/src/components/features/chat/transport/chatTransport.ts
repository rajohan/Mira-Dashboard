import type {
    ChatSendRequest,
    ChatSendResponse,
    ChatSessionPreferences,
} from "../../../../../../contracts/chat";
import type { ChatHistoryMessage } from "../chatTypes";
import type { ChatModelOption } from "../chatUtilities";
import type { ChatRuntimeEvent } from "../domain/chatState";

export interface ChatRuntimeSnapshot {
    completed: boolean;
    events: ChatRuntimeEvent[];
    /** Stable opaque identity for one Gateway endpoint/credential replay boundary. */
    replayScope?: string;
    runtimeGeneration?: string;
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
    subscribe: (listener: (event: ChatRuntimeEvent) => void) => () => void;
}
