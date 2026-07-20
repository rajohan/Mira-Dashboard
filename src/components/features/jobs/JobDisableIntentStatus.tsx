import type { JobDisableIntent } from "../../../types/job";
import { formatDate } from "../../../utils/format";
import { Button } from "../../ui/Button";

interface JobTaskLink {
    number: number;
    title: string;
}

interface JobDisableIntentStatusProperties {
    disableIntent: JobDisableIntent | undefined;
    disabled: boolean;
    onConfigureDisable: () => void;
    taskLinks?: JobTaskLink[] | undefined;
}

/** Renders the shared controls and status for an intentionally disabled job. */
export function JobDisableIntentStatus({
    disableIntent,
    disabled,
    onConfigureDisable,
    taskLinks,
}: JobDisableIntentStatusProperties) {
    return (
        <>
            <Button
                size="sm"
                variant="secondary"
                disabled={disabled}
                onClick={onConfigureDisable}
                className="w-full sm:w-auto"
            >
                {disableIntent ? "Edit disabled reason" : "Set disabled reason"}
            </Button>
            <div className="order-last w-full space-y-2 border-t border-primary-700 pt-3">
                <div className="rounded-lg bg-primary-800/60 px-3 py-2 text-xs text-primary-300">
                    {disableIntent ? (
                        <>
                            <div className="font-medium text-primary-100">
                                {disableIntent.mode === "indefinite"
                                    ? "Intentionally disabled indefinitely"
                                    : `Intentionally disabled until ${formatDate(disableIntent.until)}`}
                            </div>
                            <div className="mt-1 text-primary-400">
                                {disableIntent.comment}
                            </div>
                        </>
                    ) : (
                        <div className="text-yellow-300">
                            No intentional-disable reason is set; heartbeat will warn.
                        </div>
                    )}
                </div>
                {taskLinks && taskLinks.length > 0 ? (
                    <div className="text-xs text-primary-400">
                        Linked open tasks:{" "}
                        {taskLinks
                            .map((link) => `#${link.number} ${link.title}`)
                            .join(", ")}
                    </div>
                ) : undefined}
            </div>
        </>
    );
}
