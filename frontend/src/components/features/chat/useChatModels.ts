import { useEffect, useEffectEvent, useState } from "react";

import type { ChatModelOption } from "./chatSettings";
import type { ChatTransport } from "./transport/chatTransport";

/**
 * Loads configured models once per provider connection.
 * @returns Loaded configured models once per provider connection.
 */
export function useChatModels(transport: ChatTransport): ChatModelOption[] {
    const [models, setModels] = useState<ChatModelOption[]>([]);
    const loadModels = useEffectEvent(() => transport.models());

    useEffect(() => {
        if (!transport.isConnected) {
            return;
        }
        let isCancelled = false;
        void (async () => {
            try {
                const nextModels = await loadModels();
                if (!isCancelled) {
                    setModels(nextModels);
                }
            } catch {
                if (!isCancelled) {
                    setModels([]);
                }
            }
        })();
        return () => {
            isCancelled = true;
        };
    }, [transport.connectionGeneration, transport.isConnected]);

    return transport.isConnected ? models : [];
}
