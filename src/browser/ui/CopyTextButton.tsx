import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { IconOnlyButton } from "./IconOnlyButton.tsx";

interface CopyTextButtonProps {
    readonly iconOnly?: boolean;
    readonly label: string;
    readonly text: string;
}

type CopyState = "copied" | "idle" | "unavailable";

/**
 * Copies bounded caller-owned text through the browser clipboard API.
 * @returns A shared labelled action with persistent success/failure feedback.
 */
export function CopyTextButton({ iconOnly = false, label, text }: CopyTextButtonProps) {
    const [copiedText, setCopiedText] = useState<string>();
    const [unavailableText, setUnavailableText] = useState<string>();
    let state: CopyState = "idle";
    if (copiedText === text) state = "copied";
    else if (unavailableText === text) state = "unavailable";

    async function copyText() {
        const clipboard = globalThis.navigator.clipboard;
        if (clipboard?.writeText === undefined) {
            setCopiedText(undefined);
            setUnavailableText(text);
            return;
        }
        try {
            await clipboard.writeText(text);
            setUnavailableText(undefined);
            setCopiedText(text);
        } catch {
            setCopiedText(undefined);
            setUnavailableText(text);
        }
    }

    let visibleLabel = "Copy";
    if (state === "copied") visibleLabel = "Copied";
    else if (state === "unavailable") visibleLabel = "Copy unavailable";
    const accessibleLabel =
        state === "idle" ? label : `${label} (${visibleLabel.toLowerCase()})`;

    if (iconOnly) {
        return (
            <IconOnlyButton
                icon={state === "copied" ? Check : Copy}
                label={accessibleLabel}
                onClick={() => void copyText()}
                variant="ghost"
            />
        );
    }

    return (
        <Button
            aria-label={accessibleLabel}
            onClick={() => void copyText()}
            size="sm"
            variant="ghost"
        >
            <Icon icon={state === "copied" ? Check : Copy} size="sm" tone="inherit" />
            {visibleLabel}
        </Button>
    );
}
