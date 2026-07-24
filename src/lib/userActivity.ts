const RECENT_ACTIVITY_WINDOW_MS = 90_000;

const activityState: {
    installed: boolean;
    lastActivityAt: number;
} = {
    installed: false,
    lastActivityAt: 0,
};

function recordUserActivity(): void {
    activityState.lastActivityAt = Date.now();
}

/** Installs one lightweight set of real-interaction listeners for idle-session updates. */
export function installUserActivityTracking(): void {
    if (typeof window === "undefined" || activityState.installed) {
        return;
    }
    activityState.installed = true;
    for (const eventName of ["focus", "keydown", "pointerdown", "touchstart"] as const) {
        addEventListener(eventName, recordUserActivity, {
            capture: true,
            passive: true,
        });
    }
}

/** Returns whether an API request follows recent human interaction rather than polling alone. */
export function hasRecentUserActivity(now = Date.now()): boolean {
    return now - activityState.lastActivityAt <= RECENT_ACTIVITY_WINDOW_MS;
}

/** Resets module state for deterministic frontend tests. */
export function resetUserActivityForTests(): void {
    activityState.lastActivityAt = 0;
}
