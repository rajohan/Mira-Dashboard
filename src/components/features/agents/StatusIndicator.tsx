import { agentStatusColors } from "./status";

/** Renders the status indicator UI. */
export function StatusIndicator({ status }: { status: keyof typeof agentStatusColors }) {
    const colors = agentStatusColors[status];
    const pulseClass =
        status === "active" || status === "thinking" ? " animate-pulse" : "";

    return (
        <div
            className={
                "ring-primary-900/80 flex h-4 w-4 items-center justify-center rounded-full border ring-1 " +
                colors.border +
                " " +
                colors.glow +
                pulseClass
            }
        >
            <div className={"h-2.5 w-2.5 rounded-full " + colors.bg} />
        </div>
    );
}
