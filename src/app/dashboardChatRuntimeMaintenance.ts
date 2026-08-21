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
    const report = (error: unknown): void => {
        try {
            options.onFailure?.(error);
        } catch {
            // Failure reporting cannot terminate maintenance supervision.
        }
    };
    await options.service.sweepRetention();
    try {
        await options.service.recover();
    } catch (error) {
        // Gateway startup and reconnect are asynchronous. Recovery owns durable
        // retry semantics and must not prevent the HTTP/SSE process from becoming
        // ready while its subscription scopes wait for the connected transport.
        report(error);
    }

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
            .catch(report)
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
