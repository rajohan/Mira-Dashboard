export type AuthenticationWorkBudgetResult =
    | { readonly accepted: true }
    | { readonly accepted: false; readonly retryAfterSeconds: number };

export interface AuthenticationWorkBudget {
    consume(units?: number): AuthenticationWorkBudgetResult;
}

interface WorkEntry {
    readonly atMs: number;
    readonly units: number;
}

/**
 * Creates a bounded rolling budget for expensive authentication CPU work.
 * @param maximumUnits Maximum work units admitted within one rolling window.
 * @param windowMs Rolling-window duration in milliseconds.
 * @param monotonicNow Monotonic clock used to age admitted work.
 * @returns A process-local authentication work budget.
 */
export function createAuthenticationWorkBudget(
    maximumUnits: number,
    windowMs: number,
    monotonicNow: () => number = () => performance.now()
): AuthenticationWorkBudget {
    if (!Number.isSafeInteger(maximumUnits) || maximumUnits < 1) {
        throw new RangeError("Authentication work budget is invalid");
    }
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
        throw new RangeError("Authentication work window is invalid");
    }
    const entries: WorkEntry[] = [];
    let usedUnits = 0;
    let lastObservedAtMs = 0;

    return Object.freeze({
        consume(units = 1): AuthenticationWorkBudgetResult {
            if (!Number.isSafeInteger(units) || units < 1 || units > maximumUnits) {
                throw new RangeError("Authentication work unit count is invalid");
            }
            const observedAtMs = monotonicNow();
            if (!Number.isFinite(observedAtMs) || observedAtMs < 0) {
                throw new RangeError("Authentication work clock is invalid");
            }
            const atMs = Math.max(observedAtMs, lastObservedAtMs);
            lastObservedAtMs = atMs;
            const staleAtOrBefore = atMs - windowMs;
            while (true) {
                const first = entries[0];
                if (first === undefined || first.atMs > staleAtOrBefore) break;
                entries.shift();
                usedUnits -= first.units;
            }
            if (usedUnits + units <= maximumUnits) {
                entries.push({ atMs, units });
                usedUnits += units;
                return { accepted: true };
            }

            let unitsToExpire = usedUnits + units - maximumUnits;
            let retryAtMs = entries[0]?.atMs ?? atMs;
            for (const entry of entries) {
                unitsToExpire -= entry.units;
                retryAtMs = entry.atMs;
                if (unitsToExpire <= 0) break;
            }
            return {
                accepted: false,
                retryAfterSeconds: Math.max(
                    1,
                    Math.ceil((retryAtMs + windowMs - atMs) / 1000)
                ),
            };
        },
    });
}
