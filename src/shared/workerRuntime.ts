/** Durable execution lifecycle owned by the worker process. */
export interface DashboardWorkerRuntime {
    readonly completion: Promise<void>;
    dispose(forceSignal?: AbortSignal): Promise<void>;
    initialize(): Promise<void>;
}
