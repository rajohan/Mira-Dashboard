import { useEffect, useState } from "react";

import {
    type ChatSendRequest,
    type ChatSessionPreferences,
    parseChatSendResponse,
    parseOpenClawRuntimeSnapshot,
} from "../../../../../../contracts/chat";
import { useOpenClawSocket } from "../../../../hooks/useOpenClawSocket";
import type { ChatModelOption } from "../chatUtilities";
import type { ChatRuntimeSnapshot, ChatTransport } from "./chatTransport";
import { asRecord, openClawThroughSequence, stringValue } from "./openClawAdapterValues";
import { OpenClawChatAdapter } from "./openClawChatAdapter";
import { OpenClawHistoryLoader } from "./openClawHistoryLoader";

/**
 * Connects the provider-independent chat contract to OpenClaw's Gateway RPCs.
 * @returns Open claw chat transport state and actions.
 */
export function useOpenClawChatTransport(): ChatTransport {
    const socket = useOpenClawSocket();
    const [adapter] = useState(() => new OpenClawChatAdapter());
    const [historyLoader] = useState(
        () =>
            new OpenClawHistoryLoader(adapter, (request) =>
                socket.request("chat.history", request)
            )
    );

    useEffect(() => {
        adapter.reset();
        historyLoader.reset();
    }, [adapter, historyLoader, socket.connectionId]);

    const history = (sessionKey: string, limit: number) =>
        historyLoader.history(sessionKey, limit);

    const models = async () => {
        const result = asRecord(
            await socket.request("models.list", { view: "configured" })
        );
        return Array.isArray(result?.models)
            ? result.models.flatMap((model) => {
                  const record = asRecord(model);
                  if (!record) {
                      return [];
                  }
                  const option: ChatModelOption = {
                      id: stringValue(record.id),
                      label: stringValue(record.label),
                      name: stringValue(record.name),
                  };
                  return option.id || option.label || option.name ? [option] : [];
              })
            : [];
    };

    const send = async (request: ChatSendRequest) => {
        // OpenClaw's chat.send RPC owns configured/default queue behavior and does
        // not accept a per-request queueMode. sessions.steer is intentionally not
        // used here because that RPC aborts the active run before sending.
        return parseChatSendResponse(await socket.request("chat.send", { ...request }));
    };

    const abort = async (sessionKey: string) => {
        await socket.request("chat.abort", { sessionKey });
    };

    const compact = async (sessionKey: string) => {
        await socket.request(
            "sessions.compact",
            { key: sessionKey },
            // LLM compaction duration is owned by the Gateway lifecycle.
            { shouldWaitIndefinitely: true }
        );
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
        const rawResult = await socket.request("chat.runtimeSnapshot", { sessionKey });
        const result = parseOpenClawRuntimeSnapshot(rawResult);
        return {
            completed: result.completed,
            events: adapter.snapshot(result),
            replayScope: result.replayScope,
            runtimeGeneration: result.runtimeGeneration,
            throughSequence: openClawThroughSequence(result.throughSequence),
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
        compact,
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
