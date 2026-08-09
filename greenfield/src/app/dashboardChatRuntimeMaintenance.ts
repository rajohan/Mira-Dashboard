import type { ChatService } from "../server/domains/chat/service.ts";

export interface DashboardChatRuntimeMaintenanceScheduler {
    readonly clearInterval: (handle: unknown) => void;
    readonly setInterval: (callback: () => void, intervalMs: number) => unknown;
    readonly unref?: (handle: unknown) => void;
}

export interface DashboardChatRuntimeMaintenanceOptions {
    readonly intervalMs: number;
    readonly onFailure?: (error: unknown) => void;
    readonly scheduler?: DashboardChatRuntimeMaintenanceScheduler;
    readonly service: Pick<
        ChatService,
        "recover" | "sweepRetention" | "sweepSubscriptions"
    >;
}

export interface DashboardChatRuntimeMaintenance {
    readonly stop: () => Promise<void>;
}

const defaultScheduler: DashboardChatRuntimeMaintenanceScheduler = Object.freeze({
    clearInterval(handle: unknown) {
        clearInterval(handle as ReturnType<typeof setInterval>);
    },
    setInterval(callback: () => void, intervalMs: number) {
        return setInterval(callback, intervalMs);
    },
    unref(handle: unknown) {
        (handle as ReturnType<typeof setInterval>).unref?.();
    },
});

/**
 * Starts bounded chat recovery before scheduling single-flight maintenance.
 * @param options Reviewed maintenance service and scheduler dependencies.
 * @returns A handle that stops scheduling and awaits active maintenance.
 */
export async function startDashboardChatRuntimeMaintenance(
    options: DashboardChatRuntimeMaintenanceOptions
): Promise<DashboardChatRuntimeMaintenance> {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
        throw new TypeError("Dashboard chat maintenance interval is invalid");
    }
    await options.service.sweepRetention();
    await options.service.recover();

    const scheduler = options.scheduler ?? defaultScheduler;
    let active: Promise<void> | undefined;
    let stopped = false;
    let stopPromise: Promise<void> | undefined;
    const sweep = async (): Promise<void> => {
        await options.service.recover();
        await Promise.all([
            options.service.sweepSubscriptions(),
            options.service.sweepRetention(),
        ]);
    };
    const handle = scheduler.setInterval(() => {
        if (stopped || active !== undefined) return;
        const operation = sweep()
            .catch((error: unknown) => {
                try {
                    options.onFailure?.(error);
                } catch {
                    // Failure reporting cannot terminate maintenance supervision.
                }
            })
            .finally(() => {
                if (active === operation) active = undefined;
            });
        active = operation;
    }, options.intervalMs);
    scheduler.unref?.(handle);

    return Object.freeze({
        stop() {
            stopPromise ??= (async () => {
                stopped = true;
                scheduler.clearInterval(handle);
                await active;
            })();
            return stopPromise;
        },
    });
}
