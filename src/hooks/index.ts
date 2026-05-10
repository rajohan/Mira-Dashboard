// API utilities
export { apiDelete, apiFetch, apiPost, apiPut } from "./useApi";

// React Query
export { useQueryClient } from "@tanstack/react-query";

// Domain hooks
export {
    backupKeys,
    useKopiaBackup,
    useRunKopiaBackup,
    useRunWalgBackup,
    useWalgBackup,
} from "./useBackups";
export {
    cacheKeys,
    useCacheEntry,
    useCacheHeartbeat,
    useRefreshCacheEntry,
} from "./useCache";
export {
    configKeys,
    useConfig,
    useCreateBackup,
    useRestartGateway,
    useSkills,
    useToggleSkill,
    useUpdateConfig,
} from "./useConfig";
export type { CronJob } from "./useCron";
export {
    cronKeys,
    useCronJobs,
    useRunCronJobNow,
    useToggleCronJob,
    useUpdateCronJob,
} from "./useCron";
export { fileKeys, useFileContent, useFiles, useSaveFile } from "./useFiles";
export { useHealth } from "./useHealth";
export type { FeedItem } from "./useLiveFeed";
export { liveFeedKeys, useLiveFeed } from "./useLiveFeed";
export { logKeys, useLogContent, useLogFiles } from "./useLogs";
export { useMetrics } from "./useMetrics";
export {
    moltbookKeys,
    useMoltbookData,
    useMoltbookFeed,
    useMoltbookHome,
    useMoltbookMyContent,
    useMoltbookProfile,
} from "./useMoltbook";
export {
    useClearReadNotifications,
    useCreateNotification,
    useDeleteNotification,
    useMarkAllNotificationsRead,
    useMarkNotificationRead,
    useNotifications,
} from "./useNotifications";
export type {
    ExecJobResponse,
    ExecResponse,
    OpsActionDefinition,
    OpsActionId,
} from "./useOpsActions";
export { OPS_ACTIONS, useExecJob, useStartOpsAction } from "./useOpsActions";
export type {
    DeploymentJob,
    ProductionCheckoutStatus,
    PullRequestSummary,
    WorktreeCleanupResult,
} from "./usePullRequests";
export {
    pullRequestKeys,
    useApprovePullRequest,
    useDeployDashboard,
    useProductionCheckout,
    usePullRequestDeployments,
    usePullRequests,
    useRejectPullRequest,
} from "./usePullRequests";
export { hasQuotaStatus, useQuotas } from "./useQuotas";
export {
    sessionKeys,
    useDeleteSession,
    useSessionAction,
    useSessionHistory,
} from "./useSessions";
export {
    taskKeys,
    useAssignTask,
    useCreateTask,
    useCreateTaskUpdate,
    useDeleteTask,
    useDeleteTaskUpdate,
    useMoveTask,
    useTasks,
    useTaskUpdates,
    useUpdateTask,
    useUpdateTaskUpdate,
} from "./useTasks";
export type {
    CommandHistoryEntry,
    TerminalCommand,
    TerminalJobResponse,
} from "./useTerminal";
export {
    terminalKeys,
    useStartTerminalCommand,
    useTerminalHistory,
    useTerminalJob,
} from "./useTerminal";
export { useWeather } from "./useWeather";

// WebSocket hook (for connection management)
export { useOpenClawSocket } from "./useOpenClawSocket";
