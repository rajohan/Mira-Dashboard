import { useEffect, useState } from "react";

import {
    readStoredChatDiagnosticVisibility,
    writeStoredChatDiagnosticVisibility,
} from "./chatPageUtilities";

/**
 * Owns persisted chat diagnostic visibility and per-tool expansion overrides.
 * @param selectedSessionKey Current chat session key.
 * @param initialObservedSessionKey Session key observed during initial render.
 * @returns Diagnostic visibility state and toggle actions.
 */
export function useChatDiagnostics(
    selectedSessionKey: string,
    initialObservedSessionKey = selectedSessionKey
) {
    const [showThinkingOutput, setShowThinkingOutput] = useState(
        () => readStoredChatDiagnosticVisibility().thinking
    );
    const [showToolOutput, setShowToolOutput] = useState(
        () => readStoredChatDiagnosticVisibility().tools
    );
    const [shouldExpandToolDetails, setShouldExpandToolDetails] = useState(
        () => readStoredChatDiagnosticVisibility().toolDetailsExpanded
    );
    const [toolDetailExpansionOverrides, setToolDetailExpansionOverrides] = useState<
        Map<string, boolean>
    >(() => new Map());
    const [keepThinkingAfterFinal, setKeepThinkingAfterFinal] = useState(
        () => readStoredChatDiagnosticVisibility().keepThinkingAfterFinal
    );
    const [observedSessionKey, setObservedSessionKey] = useState(
        initialObservedSessionKey
    );

    if (observedSessionKey !== selectedSessionKey) {
        setObservedSessionKey(selectedSessionKey);
        setToolDetailExpansionOverrides(new Map());
    }

    useEffect(() => {
        writeStoredChatDiagnosticVisibility({
            keepThinkingAfterFinal,
            thinking: showThinkingOutput,
            toolDetailsExpanded: shouldExpandToolDetails,
            tools: showToolOutput,
        });
    }, [
        keepThinkingAfterFinal,
        shouldExpandToolDetails,
        showThinkingOutput,
        showToolOutput,
    ]);

    const toggleToolDetails = (toolKey: string) => {
        setToolDetailExpansionOverrides((current) => {
            const next = new Map(current);
            const isExpanded = current.get(toolKey) ?? shouldExpandToolDetails;
            next.set(toolKey, !isExpanded);
            return next;
        });
    };

    const toggleAllToolDetails = () => {
        setShouldExpandToolDetails((current) => !current);
        setToolDetailExpansionOverrides(new Map());
    };

    return {
        keepThinkingAfterFinal,
        setKeepThinkingAfterFinal,
        setShowThinkingOutput,
        setShowToolOutput,
        shouldExpandToolDetails,
        showThinkingOutput,
        showToolOutput,
        toggleAllToolDetails,
        toggleToolDetails,
        toolDetailExpansionOverrides,
    };
}
