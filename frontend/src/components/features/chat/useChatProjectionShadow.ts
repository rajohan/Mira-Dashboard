import { useState } from "react";

import type { ChatHistoryMessage } from "./chatTypes";
import {
    projectChatWithCanonicalShadow,
    type ChatProjectionShadowResult,
} from "./domain/chatCanonicalProjection";
import { createChatVisibility } from "./domain/chatPresentation";
import type { ChatRuntimeState } from "./domain/chatState";

interface ChatProjectionShadowInputs {
    deletedMessageKeys: ReadonlySet<string>;
    history: ChatHistoryMessage[];
    runtime: ChatRuntimeState;
    selectedSessionKey: string;
    shouldKeepThinkingAfterFinal: boolean;
    shouldShowThinking: boolean;
    shouldShowTools: boolean;
}

interface ChatProjectionShadowCache extends ChatProjectionShadowInputs {
    projection: ChatProjectionShadowResult;
}

function createProjectionCache(
    inputs: ChatProjectionShadowInputs
): ChatProjectionShadowCache {
    return {
        ...inputs,
        projection: projectChatWithCanonicalShadow(
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
    cache: ChatProjectionShadowCache,
    inputs: ChatProjectionShadowInputs
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
 * @returns Legacy projection plus canonical shadow comparison.
 */
export function useChatProjectionShadow(
    inputs: ChatProjectionShadowInputs
): ChatProjectionShadowResult {
    const [cache, setCache] = useState(() => createProjectionCache(inputs));
    if (hasSameProjectionInputs(cache, inputs)) {
        return cache.projection;
    }
    const next = createProjectionCache(inputs);
    setCache(next);
    return next.projection;
}
