import { useRef, useState } from "react";

import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";

/** Success/failure marker that never retains the rejected value. */
export type DashboardActionResult<TValue> =
    | Readonly<{ status: "failure" }>
    | Readonly<{ status: "success"; value: TValue }>;

/** Optional scoped fixed-message selector for one known operation failure. */
export type DashboardActionFailureMessage = (error: unknown) => string | undefined;

interface DashboardActionState {
    readonly busy: boolean;
    readonly error: string | undefined;
}

/**
 * Runs one browser security action at a time without using the mutation cache.
 * Rejections are reduced immediately to fixed safe text and never retained.
 * @returns Exclusive action state, error reset, and runner.
 */
export function useExclusiveDashboardAction() {
    const inFlight = useRef(false);
    const [state, setState] = useState<DashboardActionState>({
        busy: false,
        error: undefined,
    });

    function clearError(): void {
        if (inFlight.current) return;
        setState((current) =>
            current.error === undefined ? current : { ...current, error: undefined }
        );
    }

    async function run<TValue>(
        action: () => Promise<TValue>,
        failureMessage?: DashboardActionFailureMessage
    ): Promise<DashboardActionResult<TValue>> {
        if (inFlight.current) return { status: "failure" };
        inFlight.current = true;
        setState({ busy: true, error: undefined });
        try {
            const value = await action();
            setState({ busy: false, error: undefined });
            return { status: "success", value };
        } catch (error: unknown) {
            setState({
                busy: false,
                error: failureMessage?.(error) ?? dashboardBrowserFailureMessage(error),
            });
            return { status: "failure" };
        } finally {
            inFlight.current = false;
        }
    }

    return { ...state, clearError, run };
}
