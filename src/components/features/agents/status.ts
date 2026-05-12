/** Stores agent status colors. */
export const agentStatusColors = {
    active: {
        bg: "bg-emerald-400",
        text: "text-emerald-300",
        border: "border-emerald-300/80",
        glow: "shadow-[0_0_6px_rgba(52,211,153,0.75)]",
    },
    thinking: {
        bg: "bg-amber-300",
        text: "text-amber-300",
        border: "border-amber-200/80",
        glow: "shadow-[0_0_6px_rgba(252,211,77,0.7)]",
    },
    idle: {
        bg: "bg-sky-300",
        text: "text-primary-200",
        border: "border-sky-200/80",
        glow: "",
    },
    offline: {
        bg: "bg-primary-500",
        text: "text-primary-500",
        border: "border-primary-400/80",
        glow: "",
    },
} as const;

/** Stores agent status labels. */
export const agentStatusLabels = {
    active: "Working",
    thinking: "Thinking",
    idle: "Ready",
    offline: "Offline",
} as const;
