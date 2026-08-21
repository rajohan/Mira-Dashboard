import { createContext, use } from "react";

import type { ChatRuntimeStore } from "./chatRuntimeStore.ts";

/** Internal context shared by the authenticated provider and chat consumers. */
export const chatRuntimeStoreContext = createContext<ChatRuntimeStore | undefined>(
    undefined
);

/**
 * Reads the authenticated application's tab-local chat runtime store.
 * @returns The current authenticated cache owner's runtime store.
 */
export function useChatRuntimeStore(): ChatRuntimeStore {
    const store = use(chatRuntimeStoreContext);
    if (store === undefined) {
        throw new TypeError("Chat runtime store provider is missing");
    }
    return store;
}
