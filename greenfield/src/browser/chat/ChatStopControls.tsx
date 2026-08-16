import { Square } from "lucide-react";

import { IconOnlyButton } from "../ui/IconOnlyButton.tsx";

interface ChatStopControlsProps {
    readonly onAbort: (runId: string) => void;
    readonly runId?: string;
}

/**
 * Renders the one session-scoped provider stop action exposed by OpenClaw.
 * @returns A direct stop action when the selected session has an active run.
 */
export function ChatStopControls({ onAbort, runId }: ChatStopControlsProps) {
    if (runId === undefined) return null;
    return (
        <IconOnlyButton
            className="min-h-10 min-w-10 px-0 sm:min-h-9 sm:min-w-9"
            icon={Square}
            label="Stop response"
            onClick={() => onAbort(runId)}
            size="sm"
            variant="secondary"
        />
    );
}
