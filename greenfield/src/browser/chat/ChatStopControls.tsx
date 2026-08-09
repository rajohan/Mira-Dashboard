import { Popover, PopoverButton, PopoverPanel } from "@headlessui/react";
import { Square } from "lucide-react";

import { Button } from "../ui/Button.tsx";
import { buttonClassNames } from "../ui/buttonStyles.ts";
import { Icon } from "../ui/Icon.tsx";
import { IconOnlyButton } from "../ui/IconOnlyButton.tsx";

interface ChatStopControlsProps {
    readonly onAbort: (runId: string) => void;
    readonly runIds: readonly string[];
}

/**
 * Bounds concurrent-run stop chrome to one toolbar slot.
 * @returns Direct stop action or a compact per-run stop menu.
 */
export function ChatStopControls({ onAbort, runIds }: ChatStopControlsProps) {
    if (runIds.length === 0) return null;
    if (runIds.length === 1) {
        return (
            <IconOnlyButton
                className="min-h-10 min-w-10 px-0 sm:min-h-9 sm:min-w-9"
                icon={Square}
                label="Stop response 1"
                onClick={() => onAbort(runIds[0]!)}
                size="sm"
                variant="secondary"
            />
        );
    }
    return (
        <Popover className="relative shrink-0">
            {({ close }) => (
                <>
                    <PopoverButton
                        aria-label={`Stop responses, ${runIds.length} active`}
                        className={buttonClassNames({
                            className: "min-h-10 min-w-10 px-0 sm:min-h-9 sm:min-w-9",
                            size: "sm",
                            variant: "secondary",
                        })}
                        title={`Stop responses, ${runIds.length} active`}
                    >
                        <Icon icon={Square} size="sm" tone="inherit" />
                    </PopoverButton>
                    <PopoverPanel
                        anchor={{ gap: 8, padding: 8, to: "top end" }}
                        aria-label="Active responses"
                        className="border-primary-500 bg-primary-800 z-50 max-h-64 w-52 overflow-y-auto rounded-xl border p-2 shadow-2xl shadow-black/60"
                    >
                        <p className="text-primary-300 px-2 pb-1 text-xs">
                            {runIds.length} active responses
                        </p>
                        <div className="space-y-1">
                            {runIds.map((runId, index) => (
                                <Button
                                    className="w-full justify-start"
                                    key={runId}
                                    onClick={() => {
                                        onAbort(runId);
                                        close();
                                    }}
                                    size="sm"
                                    variant="ghost"
                                >
                                    <Icon icon={Square} size="sm" tone="inherit" />
                                    Stop response {index + 1}
                                </Button>
                            ))}
                        </div>
                    </PopoverPanel>
                </>
            )}
        </Popover>
    );
}
