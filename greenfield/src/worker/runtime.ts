/** Database-validation lifecycle owned by the worker process. */
export interface DashboardWorkerRuntime {
    dispose(): Promise<void>;
    initialize(): Promise<void>;
}
