import { useRef } from "react";

import { useOpenClawSocket } from "../../../../hooks/useOpenClawSocket";
import type { ChatModelOption } from "../chatUtilities";
import type {
    ChatRuntimeSnapshot,
    ChatSendRequest,
    ChatSessionPreferences,
    ChatTransport,
} from "./chatTransport";
import { asRecord, openClawThroughSequence, stringValue } from "./openClawAdapterValues";
import { OpenClawChatAdapter } from "./openClawChatAdapter";
import { OpenClawHistoryLoader } from "./openClawHistoryLoader";

/** Connects the provider-independent chat contract to OpenClaw's Gateway RPCs. */
export function useOpenClawChatTransport(): ChatTransport {
    const socket = useOpenClawSocket();
    const adapterReference = useRef<{
        adapter: OpenClawChatAdapter;
        generation: number;
        historyLoader: OpenClawHistoryLoader;
    }>(undefined);
    if (adapterReference.current?.generation !== socket.connectionId) {
        const adapter = new OpenClawChatAdapter();
        adapterReference.current = {
            adapter,
            generation: socket.connectionId,
            historyLoader: new OpenClawHistoryLoader(adapter, (request) =>
                socket.request("chat.history", request)
            ),
        };
    }
    const adapter = adapterReference.current.adapter;
    const historyLoader = adapterReference.current.historyLoader;

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
        const result = asRecord(await socket.request("chat.send", { ...request }));
        return { runId: stringValue(result?.runId) };
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
        const result = asRecord(rawResult);
        return {
            completed: result?.completed === true,
            events: adapter.snapshot(rawResult),
            replayScope: stringValue(result?.replayScope) || undefined,
            runtimeGeneration: stringValue(result?.runtimeGeneration) || undefined,
            throughSequence: openClawThroughSequence(result?.throughSequence),
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
