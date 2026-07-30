import { useState } from "react";

import type { ChatHistoryMessage } from "./chatTypes";
import {
    type CanonicalChatProjection,
    projectCanonicalChat,
} from "./domain/chatCanonicalProjection";
import { createChatVisibility } from "./domain/chatPresentation";
import type { ChatRuntimeState } from "./domain/chatState";

interface CanonicalChatProjectionInputs {
    deletedMessageKeys: ReadonlySet<string>;
    history: ChatHistoryMessage[];
    runtime: ChatRuntimeState;
    selectedSessionKey: string;
    shouldKeepThinkingAfterFinal: boolean;
    shouldShowThinking: boolean;
    shouldShowTools: boolean;
}

interface CanonicalChatProjectionCache extends CanonicalChatProjectionInputs {
    projection: CanonicalChatProjection;
}

function createProjectionCache(
    inputs: CanonicalChatProjectionInputs
): CanonicalChatProjectionCache {
    return {
        ...inputs,
        projection: projectCanonicalChat(
            inputs.history,
            inputs.runtime,
            inputs.selectedSessionKey,
            createChatVisibility(inputs.shouldShowThinking, inputs.shouldShowTools),
            inputs.shouldKeepThinkingAfterFinal,
            inputs.deletedMessageKeys
        ),
    };
}

function hasSameProjectionInputs(
    cache: CanonicalChatProjectionCache,
    inputs: CanonicalChatProjectionInputs
): boolean {
    return (
        cache.deletedMessageKeys === inputs.deletedMessageKeys &&
        (cache.history === inputs.history ||
            (cache.history.length === 0 && inputs.history.length === 0)) &&
        cache.runtime === inputs.runtime &&
        cache.selectedSessionKey === inputs.selectedSessionKey &&
        cache.shouldKeepThinkingAfterFinal === inputs.shouldKeepThinkingAfterFinal &&
        cache.shouldShowThinking === inputs.shouldShowThinking &&
        cache.shouldShowTools === inputs.shouldShowTools
    );
}

/**
 * Projects chat only when one of its semantic projection inputs changes.
 * This render-local derived-state cache avoids transcript-wide work for
 * unrelated parent renders such as composer keystrokes.
 * @param inputs Semantic projection inputs.
 * @returns Canonical turns and their UI projection.
 */
export function useCanonicalChatProjection(
    inputs: CanonicalChatProjectionInputs
): CanonicalChatProjection {
    const [cache, setCache] = useState(() => createProjectionCache(inputs));
    if (hasSameProjectionInputs(cache, inputs)) {
        return cache.projection;
    }
    const next = createProjectionCache(inputs);
    setCache(next);
    return next.projection;
}
