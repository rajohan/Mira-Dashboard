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
        const result = asRecord(
            await socket.request("chat.history", { limit, sessionKey })
        );
        return adapter.history(result?.messages);
    };

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
        const result = asRecord(await socket.request("chat.send", { ...request }));
        return { runId: stringValue(result?.runId) };
    };

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
        const rawResult = await socket.request("chat.runtimeSnapshot", { sessionKey });
        const result = asRecord(rawResult);
        return {
            completed: result?.completed === true,
            events: adapter.snapshot(rawResult),
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
