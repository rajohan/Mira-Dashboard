import { Check, Copy, TriangleAlert } from "lucide-react";
import { useEffect, useState, type ComponentProps } from "react";

import { Button } from "./Button";

type CopyStatus = "copied" | "error" | "idle";

/** Provides props for a clipboard copy control. */
interface CopyButtonProperties {
    className?: string;
    content: string;
    label?: string;
    variant?: ComponentProps<typeof Button>["variant"];
}

/**
 * Copies text to the clipboard with short accessible result feedback.
 * @returns A clipboard copy button.
 */
export function CopyButton({
    className,
    content,
    label = "Copy",
    variant = "ghost",
}: CopyButtonProperties) {
    const [status, setStatus] = useState<CopyStatus>("idle");

    useEffect(() => {
        if (status === "idle") return;
        const timeout = globalThis.setTimeout(() => setStatus("idle"), 1500);
        return () => globalThis.clearTimeout(timeout);
    }, [status]);

    async function copyContent(): Promise<void> {
        try {
            if (!navigator.clipboard) {
                throw new Error("Clipboard API unavailable");
            }
            await navigator.clipboard.writeText(content);
            setStatus("copied");
        } catch {
            setStatus("error");
        }
    }

    let buttonLabel = label;
    let StatusIcon = Copy;
    if (status === "copied") {
        buttonLabel = "Copied";
        StatusIcon = Check;
    } else if (status === "error") {
        buttonLabel = "Copy failed";
        StatusIcon = TriangleAlert;
    }

    return (
        <Button
            aria-live="polite"
            className={className}
            onClick={() => void copyContent()}
            size="sm"
            title={buttonLabel}
            type="button"
            variant={variant}
        >
            <StatusIcon aria-hidden="true" className="size-3.5" />
            {buttonLabel}
        </Button>
    );
}
