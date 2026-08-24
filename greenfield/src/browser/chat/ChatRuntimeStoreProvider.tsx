import type { ReactNode } from "react";
import { useState } from "react";

import { chatRuntimeStoreContext as ChatRuntimeStoreContext } from "./chatRuntimeContextValue.ts";
import { createChatRuntimeStore } from "./chatRuntimeStore.ts";

interface ChatRuntimeStoreProviderProps {
    readonly children: ReactNode;
}

/**
 * Owns one runtime reducer across route transitions for one authenticated cache owner.
 * @returns The authenticated chat runtime-store boundary.
 */
export function ChatRuntimeStoreProvider({ children }: ChatRuntimeStoreProviderProps) {
    const [store] = useState(createChatRuntimeStore);
    return <ChatRuntimeStoreContext value={store}>{children}</ChatRuntimeStoreContext>;
}
