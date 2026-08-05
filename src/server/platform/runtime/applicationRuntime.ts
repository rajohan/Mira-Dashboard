import { Effect, ManagedRuntime, type Layer, Stream } from "effect";

import type { RealtimeEventDelivery } from "../realtime/eventPump.ts";
import type { RealtimeEventStreamOptions } from "../realtime/eventPumpService.ts";
import { RealtimeEventPumpService } from "../realtime/eventPumpService.ts";

/** Request-safe realtime methods backed by the process runtime. */
export interface RealtimeEventRuntimeService {
    stream(
        options: RealtimeEventStreamOptions
    ): Promise<AsyncIterable<RealtimeEventDelivery>>;
}

/** Request-safe process services without lifecycle controls. */
export interface ApplicationRuntimeServices {
    readonly realtimeEvents: RealtimeEventRuntimeService;
}

/** Effect-backed lifecycle and request services owned by one long-lived Bun process. */
export interface ApplicationRuntime {
    readonly services: ApplicationRuntimeServices;
    dispose(): Promise<void>;
    /** Eagerly builds and caches every process-owned layer before readiness. */
    initialize(): Promise<void>;
}

/** Scoped layers owned by one composition root for the full process lifetime. */
export interface ApplicationRuntimeOptions {
    readonly realtimeEventPumpLayer: Layer.Layer<RealtimeEventPumpService>;
}

/**
 * Creates one reusable Effect runtime whose scope is owned by the current process.
 * `initialize` eagerly prewarms the otherwise lazy layer before the listener opens;
 * `dispose` releases it after active HTTP and SSE requests have stopped.
 * @param options Scoped application layers.
 * @returns One reusable and explicitly disposable application runtime.
 */
export function createApplicationRuntime(
    options: ApplicationRuntimeOptions
): ApplicationRuntime {
    const runtime = ManagedRuntime.make(options.realtimeEventPumpLayer);
    let disposePromise: Promise<void> | undefined;
    const services: ApplicationRuntimeServices = Object.freeze({
        realtimeEvents: Object.freeze({
            stream(streamOptions: RealtimeEventStreamOptions) {
                return runtime.runPromise(
                    RealtimeEventPumpService.pipe(
                        Effect.flatMap((service) =>
                            Stream.toAsyncIterableEffect(service.stream(streamOptions))
                        )
                    ),
                    { signal: streamOptions.signal }
                );
            },
        }),
    });

    return Object.freeze({
        dispose() {
            disposePromise ??= runtime.dispose();
            return disposePromise;
        },
        async initialize() {
            await runtime.context();
        },
        services,
    });
}
