import { useRef, useState } from "react";

import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";

/** Success/failure marker that never retains the rejected value. */
export type DashboardActionResult<TValue> =
    | Readonly<{ status: "failure" }>
    | Readonly<{ status: "success"; value: TValue }>;

interface DashboardActionState {
    readonly busy: boolean;
    readonly error: string | undefined;
}

/**
 * Runs one browser security action at a time without using the mutation cache.
 * Rejections are reduced immediately to fixed safe text and never retained.
 * @returns Exclusive action state and runner.
 */
export function useExclusiveDashboardAction() {
    const inFlight = useRef(false);
    const [state, setState] = useState<DashboardActionState>({
        busy: false,
        error: undefined,
    });

    async function run<TValue>(
        action: () => Promise<TValue>
    ): Promise<DashboardActionResult<TValue>> {
        if (inFlight.current) return { status: "failure" };
        inFlight.current = true;
        setState({ busy: true, error: undefined });
        try {
            const value = await action();
            setState({ busy: false, error: undefined });
            return { status: "success", value };
        } catch (error: unknown) {
            setState({ busy: false, error: dashboardBrowserFailureMessage(error) });
            return { status: "failure" };
        } finally {
            inFlight.current = false;
        }
    }

    return { ...state, run };
}
