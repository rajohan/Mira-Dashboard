import { useEffect, useRef, useState } from "react";

import type { ChatModelOption } from "./chatUtilities";
import type { ChatTransport } from "./transport/chatTransport";

/** Loads configured models once per provider connection. */
export function useChatModels(transport: ChatTransport): ChatModelOption[] {
    const [models, setModels] = useState<ChatModelOption[]>([]);
    const transportReference = useRef(transport);
    transportReference.current = transport;

    useEffect(() => {
        if (!transport.isConnected) {
            setModels([]);
            return;
        }
        let isCancelled = false;
        void transportReference.current
            .models()
            .then((nextModels) => {
                if (!isCancelled) {
                    setModels(nextModels);
                }
            })
            .catch(() => {
                if (!isCancelled) {
                    setModels([]);
                }
            });
        return () => {
            isCancelled = true;
        };
    }, [transport.connectionGeneration, transport.isConnected]);

    return models;
}
