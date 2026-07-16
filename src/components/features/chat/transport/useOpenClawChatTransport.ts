import { useRef } from "react";

import { useOpenClawSocket } from "../../../../hooks/useOpenClawSocket";
import type { ChatModelOption } from "../chatUtilities";
import type {
    ChatRuntimeSnapshot,
    ChatSendRequest,
    ChatSessionPreferences,
    ChatTransport,
} from "./chatTransport";
import { OpenClawChatAdapter, type OpenClawRuntimeSnapshot } from "./openClawChatAdapter";
import type { RawOpenClawHistoryMessage } from "./openClawHistoryNormalizer";

/** Connects the provider-independent chat contract to OpenClaw's Gateway RPCs. */
export function useOpenClawChatTransport(): ChatTransport {
    const socket = useOpenClawSocket();
    const adapterReference = useRef<{
        adapter: OpenClawChatAdapter;
        generation: number;
    }>(undefined);
    if (adapterReference.current?.generation !== socket.connectionId) {
        adapterReference.current = {
            adapter: new OpenClawChatAdapter(),
            generation: socket.connectionId,
        };
    }
    const adapter = adapterReference.current.adapter;

    const history = async (sessionKey: string, limit: number) => {
        const result = await socket.request<{
            messages?: RawOpenClawHistoryMessage[];
        }>("chat.history", { limit, sessionKey });
        return adapter.history(result.messages);
    };

    const models = async () => {
        const result = await socket.request<{ models?: ChatModelOption[] }>(
            "models.list",
            { view: "configured" }
        );
        return result.models || [];
    };

    const send = (request: ChatSendRequest) =>
        socket.request<{ runId?: string }>("chat.send", { ...request });

    const abort = async (sessionKey: string) => {
        await socket.request("chat.abort", { sessionKey });
    };

    const patchSession = async (
        sessionKey: string,
        preferences: ChatSessionPreferences
    ) => {
        await socket.request("sessions.patch", {
            key: sessionKey,
            ...preferences,
        });
    };

    const snapshot = async (sessionKey: string): Promise<ChatRuntimeSnapshot> => {
        const result = await socket.request<OpenClawRuntimeSnapshot>(
            "chat.runtimeSnapshot",
            { sessionKey }
        );
        return {
            completed: result.completed === true,
            events: adapter.snapshot(result),
            throughSequence:
                typeof result.throughSequence === "number"
                    ? result.throughSequence * 16 + 15
                    : 0,
        };
    };

    const subscribe = (listener: Parameters<ChatTransport["subscribe"]>[0]) =>
        socket.subscribe((raw) => {
            for (const event of adapter.event(raw)) {
                listener(event);
            }
        });

    return {
        abort,
        connectionGeneration: socket.connectionId,
        error: socket.error,
        history,
        isConnected: socket.isConnected,
        models,
        patchSession,
        send,
        snapshot,
        subscribe,
    };
}
