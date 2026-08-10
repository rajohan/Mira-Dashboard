import { toJsonSchema } from "@valibot/to-json-schema";

import { hasValidPossessionFactorInventory } from "../../src/contracts/accountSecurity.ts";
import {
    activeRunTimeIsConsistent,
    agentDefinitionsHaveUniqueIds,
    agentStatusProjectionIsConsistent,
    canonicalAgentDefinitions,
    completedRunTimeIsConsistent,
    workingStatusTimeIsConsistent,
} from "../../src/contracts/agentModel.ts";
import {
    agentTaskHistoryCursorIsConsistent,
    canonicalAgentStatuses,
    newestAgentTaskRunOrderIsStable,
} from "../../src/contracts/agents.ts";
import {
    authPasswordMaximumLength,
    authPasswordMinimumLength,
    browserSessionUserAgentMaximumLength,
    hasValidAuthPasswordLength,
    isValidBrowserSessionUserAgent,
} from "../../src/contracts/auth.ts";
import {
    automationCredentialDoesNotReplaceItself,
    automationCredentialPageCountIsConsistent,
    automationCredentialPageCursorIsConsistent,
    automationCredentialRowsHaveStableOrder,
    automationCredentialTimesAreOrdered,
    automationPrincipalCredentialCountsAreConsistent,
    automationPrincipalPageCountsAreConsistent,
    automationPrincipalPageCursorIsConsistent,
    automationPrincipalRowsHaveStableOrder,
    automationPrincipalTimesAreOrdered,
    createdAutomationCredentialResultIsConsistent,
    createdAutomationPrincipalResultIsConsistent,
    disabledAutomationPrincipalResultIsConsistent,
    revokedAutomationCredentialResultIsConsistent,
    rotatedAutomationCredentialResultIsConsistent,
} from "../../src/contracts/automationSecurity.ts";
import {
    cacheEntryIsConsistent,
    cacheEntryMetadataFitsBudget,
    cacheEntryPayloadFitsBudget,
    cacheEntryStatusIsConsistent,
    cacheHeartbeatConnectionIsConsistent,
    cacheHeartbeatCronLastKnownGoodIsConsistent,
    cacheHeartbeatResultIsConsistent,
    cacheHeartbeatSessionsLastKnownGoodIsConsistent,
    cacheStatusEntriesAreCanonical,
    cacheStatusResultIsConsistent,
    systemHostCapacityIsConsistent,
} from "../../src/contracts/cache.ts";
import { cacheRealtimeIdentityMatches } from "../../src/contracts/cacheRealtime.ts";
import {
    availableChatMessageIsCompleteAndFitsBudget,
    chatExternalRunsHaveUniqueProviderIds,
    chatHistoryMessagesHaveUniqueIds,
    chatHistoryOutputFitsBudget,
    chatModelsHaveUniqueIds,
    chatRuntimeOutputIsConsistent,
    chatSendInputFitsAdmissionBudget,
    chatSendInputHasContent,
    chatSessionSettingsPatchIsNonempty,
} from "../../src/contracts/chat.ts";
import {
    chatAttachmentAggregateRawBytesFit,
    chatAttachmentTicketFileMimeTypeIsSupported,
    chatAttachmentTicketUploadsAreConsistent,
    normalizeChatAttachmentTicketFile,
} from "../../src/contracts/chatMedia.ts";
import {
    chatMessageAttachmentDispositionIsConsistent,
    chatMessageFitsHydrationBudget,
    chatMessagePartsHaveUniqueIds,
    chatMessagePartToolStateIsConsistent,
    chatExternalRunFitsBudget,
    chatPlanStepsHaveAtMostOneActive,
    chatRunSummaryIsConsistent,
    chatRuntimeEventProviderRangeIsConsistent,
    chatRuntimeEventToolStateIsConsistent,
    chatRuntimeProjectionPartsAreOrdered,
    chatRuntimeProjectionToolStateIsConsistent,
    chatRuntimeSnapshotFitsBudget,
} from "../../src/contracts/chatModel.ts";
import {
    chatSpeechSynthesisTextFitsByteBudget,
    chatSpeechTranscriptFitsByteBudget,
    normalizeChatSpeechSynthesisText,
} from "../../src/contracts/chatSpeech.ts";
import { workspaceFileNameIsSafe } from "../../src/contracts/files.ts";
import { gatewayConnectionSnapshotIsConsistent } from "../../src/contracts/gatewayConnection.ts";
import {
    freshGatewaySessionSourceTimesAreConsistent,
    gatewaySessionActionResultIsConsistent,
    gatewaySessionLifecycleIsConsistent,
    gatewaySessionOmittedMetadataFieldsAreCanonical,
    gatewaySessionPageIsCanonical,
    gatewaySessionSnapshotIsConsistent,
    gatewaySessionTokenFreshnessIsConsistent,
    staleGatewaySessionSourceTimesAreConsistent,
} from "../../src/contracts/gatewaySessions.ts";
import {
    incidentPageCursorIsConsistent,
    newestIncidentOrderIsStable,
} from "../../src/contracts/incidents.ts";
import {
    activeJobDisableIntentTimesAreConsistent,
    jobPayloadFitsBudget,
    jobResourceKeysAreCanonical,
    jobRunEventIsConsistent,
    jobRunEventMessageFitsBudget,
    jobRunEventProgressFitsBudget,
    jobRunResultFitsBudget,
    jobRunSummaryIsConsistent,
    jobWorkerSummaryIsConsistent,
    normalizeScheduleCronExpression,
    scheduleCronExpressionIsValid,
    scheduleSummaryIsConsistent,
    scheduleTimeZoneIsCanonical,
} from "../../src/contracts/jobModel.ts";
import { jobRealtimeIdentityMatches } from "../../src/contracts/jobRealtime.ts";
import {
    activeJobResourceClassesAreCanonical,
    jobQueueSummaryIsConsistent,
    jobRunDetailIsConsistent,
    jobRunPageCursorIsConsistent,
    jobWorkerSummariesAreCanonical,
    newestJobRunEventOrderIsStable,
    newestJobRunOrderIsStable,
} from "../../src/contracts/jobs.ts";
import {
    logLinesHaveUniqueIds,
    logMaintenancePoliciesHaveUniqueIds,
    logSourcesHaveUniqueIds,
} from "../../src/contracts/logs.ts";
import {
    activeIncidentSummaryTimesAreConsistent,
    activeIncidentTimesAreConsistent,
    completeMonitoringSnapshotFitsBudget,
    completeMonitoringSnapshotTimesAreConsistent,
    monitoringJsonObjectFitsBudget,
    notificationIncidentReferenceIsConsistent,
    notificationTimesAreConsistent,
    resolvedIncidentSummaryTimesAreConsistent,
    resolvedIncidentTimesAreConsistent,
} from "../../src/contracts/monitoring.ts";
import {
    bulkNotificationContinuationIsConsistent,
    newestNotificationOrderIsStable,
    notificationInputIncidentReferenceIsConsistent,
    notificationPageMaximum,
    notificationPageCursorIsConsistent,
} from "../../src/contracts/notifications.ts";
import {
    openClawCronAtScheduleIsValid,
    openClawCronEnabledTransitionIsConsistent,
    openClawCronJobIsConsistent,
    openClawCronLastKnownGoodTimesAreConsistent,
    openClawCronPageIsConsistent,
    openClawCronRunOutcomeIsConsistent,
    openClawCronRunPageIsConsistent,
    openClawCronUpdatePatchIsNonempty,
} from "../../src/contracts/openClawCron.ts";
import {
    openClawTaskCancelledResultWasFound,
    openClawTaskCancelSnapshotMatchesFound,
    openClawTaskDetailLifecycleIsConsistent,
    openClawTaskListOutputFitsBudget,
    openClawTaskSummaryLifecycleIsConsistent,
    openClawTasksHaveUniqueIds,
} from "../../src/contracts/openClawTasks.ts";
import type { ContractSchema } from "../../src/contracts/registry.ts";
import {
    newestReportOrderIsStable,
    reportPageCursorIsConsistent,
    upsertReportInputFitsBudget,
} from "../../src/contracts/reports.ts";
import {
    scheduleOrderIsStable,
    schedulePageCursorIsConsistent,
    scheduleRunPageCursorIsConsistent,
    scheduleUpdatePatchIsConsistent,
} from "../../src/contracts/schedules.ts";
import {
    isValidSecurityLabel,
    securityLabelMaximumLength,
    sortApplicationCapabilities,
} from "../../src/contracts/security.ts";
import {
    securityAuditEventsHaveStableOrder,
    securityAuditPageCursorIsConsistent,
} from "../../src/contracts/securityAudit.ts";
import { systemMetricCapacityIsConsistent } from "../../src/contracts/system.ts";
import {
    canonicalizeTaskStrings,
    freezeTaskStrings,
    taskDetailTimesAreOrdered,
    taskProgressTimesAreOrdered,
    taskStringsAreSorted,
    taskTextIsTrimmed,
    taskTimesAreOrdered,
} from "../../src/contracts/taskModel.ts";
import {
    newestProgressOrderIsStable,
    newestTaskOrderIsStable,
    taskPageCursorIsConsistent,
    taskPatchHasChange,
    taskProgressPageCursorIsConsistent,
} from "../../src/contracts/tasks.ts";
import {
    terminalPathIsCanonical,
    terminalRootsAreCanonical,
} from "../../src/contracts/terminal.ts";
import {
    hasMatchingWebAuthnAuthenticationCredentialIds,
    hasMatchingWebAuthnRegistrationCredentialIds,
    isCanonicalWebAuthnBase64Url,
    sortWebAuthnTransports,
} from "../../src/contracts/webauthn.ts";
import { jsonObjectSchema } from "../../src/shared/json.ts";
import {
    getBoundedNonBlankTextMaximumLength,
    hasNoNulCharacter,
    hasNoUnicodeControlOrFormat,
    hasUniqueArrayItems,
} from "../../src/shared/validation.ts";

/** JSON Schema conversion direction for transport schemas. */
export type SchemaTypeMode = "input" | "output";

// JSON Schema cannot carry JavaScript's Unicode flag. Encode astral Cf code
// points as surrogate pairs so this remains equivalent to the Valibot \p{Cc}/\p{Cf}
// predicate under the documented ECMA-262 pattern dialect.
const securityLabelControlOrFormatPattern = [
    String.raw`[\u0000-\u001F\u007F-\u009F\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]`,
    String.raw`\uD804[\uDCBD\uDCCD]`,
    String.raw`\uD80D[\uDC30-\uDC3F]`,
    String.raw`\uD82F[\uDCA0-\uDCA3]`,
    String.raw`\uD834[\uDD73-\uDD7A]`,
    String.raw`\uDB40(?:\uDC01|[\uDC20-\uDC7F])`,
].join("|");
const securityLabelJsonSchemaPattern = `^(?=[\\s\\S]*\\S)(?![\\s\\S]*(?:${securityLabelControlOrFormatPattern}))[\\s\\S]+$`;
const controlSafeTextJsonSchemaPattern = `^(?![\\s\\S]*(?:${securityLabelControlOrFormatPattern}))[\\s\\S]*$`;
const noNulJsonSchemaPattern = String.raw`^[^\u0000]*$`;

const runtimeCheckComments = new Map<unknown, string>([
    [
        workspaceFileNameIsSafe,
        "Live Valibot validation additionally rejects traversal names and path separators and limits the literal child name to 255 UTF-8 bytes.",
    ],
    [
        logSourcesHaveUniqueIds,
        "Live Valibot validation additionally requires every named log source ID to be unique.",
    ],
    [
        logLinesHaveUniqueIds,
        "Live Valibot validation additionally requires every redacted log line ID to be unique.",
    ],
    [
        logMaintenancePoliciesHaveUniqueIds,
        "Live Valibot validation additionally requires every fixed log-maintenance policy ID to be unique.",
    ],
    [
        terminalPathIsCanonical,
        "Live Valibot validation additionally rejects dot and parent segments in the root-relative initial terminal path.",
    ],
    [
        terminalRootsAreCanonical,
        "Live Valibot validation additionally requires unique terminal root IDs in canonical ascending order.",
    ],
    [
        chatSpeechTranscriptFitsByteBudget,
        "Live Valibot validation additionally limits the ephemeral transcript to 65536 UTF-8 bytes.",
    ],
    [
        chatSpeechSynthesisTextFitsByteBudget,
        "Live Valibot validation additionally limits speech synthesis text to 16384 UTF-8 bytes.",
    ],
    [
        gatewayConnectionSnapshotIsConsistent,
        "Live Valibot validation additionally requires connected phase and fresh state to agree and past transport timestamps not to exceed the check time.",
    ],
    [
        chatHistoryMessagesHaveUniqueIds,
        "Live Valibot validation additionally requires every chat history message ID to be unique.",
    ],
    [
        chatHistoryOutputFitsBudget,
        "Live Valibot validation additionally limits the serialized chat history response to its reviewed UTF-8 byte budget.",
    ],
    [
        availableChatMessageIsCompleteAndFitsBudget,
        "Live Valibot validation additionally requires an available hydrated chat message to be complete and within its reviewed UTF-8 byte budget.",
    ],
    [
        chatSendInputHasContent,
        "Live Valibot validation additionally requires nonblank chat text or an attachment ticket.",
    ],
    [
        chatSendInputFitsAdmissionBudget,
        "Live Valibot validation additionally limits the canonical serialized chat send intent to 131072 UTF-8 bytes, stricter than the shared history-message code-unit cap.",
    ],
    [
        chatModelsHaveUniqueIds,
        "Live Valibot validation additionally requires every configured chat model ID to be unique.",
    ],
    [
        chatSessionSettingsPatchIsNonempty,
        "Live Valibot validation additionally requires at least one reviewed chat session setting to change.",
    ],
    [
        chatExternalRunsHaveUniqueProviderIds,
        "Live Valibot validation additionally requires every external chat projection to have a unique provider run ID.",
    ],
    [
        chatExternalRunFitsBudget,
        "Live Valibot validation additionally limits each external chat run projection to its reviewed UTF-8 byte budget.",
    ],
    [
        chatRuntimeOutputIsConsistent,
        "Live Valibot validation additionally binds chat cursors, continuation/reset state, ordered unique run snapshots, session identity, and the aggregate UTF-8 response budget.",
    ],
    [
        chatAttachmentTicketFileMimeTypeIsSupported,
        "Live Valibot validation additionally requires the declared MIME type and filename extension to resolve to one reviewed attachment type.",
    ],
    [
        chatAttachmentAggregateRawBytesFit,
        "Live Valibot validation additionally limits all files in one attachment ticket to the reviewed aggregate raw-byte budget.",
    ],
    [
        chatAttachmentTicketUploadsAreConsistent,
        "Live Valibot validation additionally requires unique attachment IDs, exact same-origin ticket upload URLs, and the reviewed response byte budget.",
    ],
    [
        chatMessagePartToolStateIsConsistent,
        "Live Valibot validation additionally requires chat tool phase, failure state, and failed output to agree.",
    ],
    [
        chatMessageAttachmentDispositionIsConsistent,
        "Live Valibot validation additionally binds each chat attachment render policy to its exact managed-media URL disposition.",
    ],
    [
        chatMessagePartsHaveUniqueIds,
        "Live Valibot validation additionally requires every part ID in one chat message to be unique.",
    ],
    [
        chatMessageFitsHydrationBudget,
        "Live Valibot validation additionally limits each serialized chat message to its reviewed hydration UTF-8 byte budget.",
    ],
    [
        chatRunSummaryIsConsistent,
        "Live Valibot validation additionally binds chat run lifecycle, terminal, cancellation, reconciliation, and update timestamps.",
    ],
    [
        chatPlanStepsHaveAtMostOneActive,
        "Live Valibot validation additionally permits at most one in-progress step in a chat plan.",
    ],
    [
        chatRuntimeEventToolStateIsConsistent,
        "Live Valibot validation additionally requires runtime tool phase, failure state, and failed output to agree.",
    ],
    [
        chatRuntimeEventProviderRangeIsConsistent,
        "Live Valibot validation additionally requires provider sequence range endpoints to be absent together or ordered together.",
    ],
    [
        chatRuntimeProjectionToolStateIsConsistent,
        "Live Valibot validation additionally requires projected tool phase, failure state, and failed output to agree.",
    ],
    [
        chatRuntimeProjectionPartsAreOrdered,
        "Live Valibot validation additionally requires projected chat parts in strict ascending event-sequence order.",
    ],
    [
        chatRuntimeSnapshotFitsBudget,
        "Live Valibot validation additionally binds snapshot sequence bounds and terminal plan omission and enforces the reviewed UTF-8 byte budget.",
    ],
    [
        openClawTaskSummaryLifecycleIsConsistent,
        "Live Valibot validation additionally binds OpenClaw task identity aliases and orders available lifecycle timestamps.",
    ],
    [
        openClawTaskDetailLifecycleIsConsistent,
        "Live Valibot validation additionally binds OpenClaw task detail identity aliases and orders available lifecycle timestamps.",
    ],
    [
        openClawTasksHaveUniqueIds,
        "Live Valibot validation additionally requires every OpenClaw task ID in a page to be unique.",
    ],
    [
        openClawTaskListOutputFitsBudget,
        "Live Valibot validation additionally limits the serialized OpenClaw task page to its reviewed UTF-8 byte budget.",
    ],
    [
        openClawTaskCancelledResultWasFound,
        "Live Valibot validation additionally requires a cancelled OpenClaw task to have been found.",
    ],
    [
        openClawTaskCancelSnapshotMatchesFound,
        "Live Valibot validation additionally requires OpenClaw task lookup state and the optional returned snapshot to agree.",
    ],
    [
        openClawCronAtScheduleIsValid,
        "Live Valibot validation additionally requires the one-time schedule string to parse to a finite timestamp.",
    ],
    [
        openClawCronLastKnownGoodTimesAreConsistent,
        "Live Valibot validation additionally requires staleness to begin at or after the last observation.",
    ],
    [
        openClawCronJobIsConsistent,
        "Live Valibot validation additionally requires delivery metadata and desired enabled-state synchronization to agree with the projected job.",
    ],
    [
        openClawCronPageIsConsistent,
        "Live Valibot validation additionally requires jobs, offsets, continuation, and total count to describe one coherent bounded page.",
    ],
    [
        openClawCronRunPageIsConsistent,
        "Live Valibot validation additionally requires run rows, offsets, continuation, and total count to describe one coherent bounded page.",
    ],
    [
        openClawCronRunOutcomeIsConsistent,
        "Live Valibot validation additionally requires a reason exactly when an immediate run was not accepted.",
    ],
    [
        openClawCronEnabledTransitionIsConsistent,
        "Live Valibot validation additionally requires a disable intent only for disabling and an explicit null intent when enabling.",
    ],
    [
        openClawCronUpdatePatchIsNonempty,
        "Live Valibot validation additionally requires at least one reviewed OpenClaw cron field to change.",
    ],
    [
        gatewaySessionTokenFreshnessIsConsistent,
        "Live Valibot validation additionally requires a token count whenever Gateway marks the token count fresh.",
    ],
    [
        gatewaySessionLifecycleIsConsistent,
        "Live Valibot validation additionally requires active-run and session lifecycle timestamps to agree.",
    ],
    [
        gatewaySessionOmittedMetadataFieldsAreCanonical,
        "Live Valibot validation additionally requires omitted Gateway metadata fields to be unique and canonically ordered.",
    ],
    [
        gatewaySessionPageIsCanonical,
        "Live Valibot validation additionally requires unique session keys and primary-main, kind, recency, then key ordering.",
    ],
    [
        freshGatewaySessionSourceTimesAreConsistent,
        "Live Valibot validation additionally requires fresh Gateway check and observation timestamps to match.",
    ],
    [
        staleGatewaySessionSourceTimesAreConsistent,
        "Live Valibot validation additionally requires a stale Gateway check timestamp at or after its observation timestamp.",
    ],
    [
        gatewaySessionSnapshotIsConsistent,
        "Live Valibot validation additionally requires the filter, projected rows, and derived same-snapshot statistics to agree.",
    ],
    [
        gatewaySessionActionResultIsConsistent,
        "Live Valibot validation additionally allows an unchanged outcome only for compact and requires any returned snapshot to use the ALL filter.",
    ],
    [
        systemMetricCapacityIsConsistent,
        "Live Valibot validation additionally requires capacity bytes and the rounded percentage to describe one consistent state.",
    ],
    [
        cacheEntryPayloadFitsBudget,
        "Live Valibot validation additionally limits the serialized cache payload to its reviewed UTF-8 byte budget.",
    ],
    [
        cacheEntryMetadataFitsBudget,
        "Live Valibot validation additionally limits serialized cache metadata to its reviewed UTF-8 byte budget.",
    ],
    [
        systemHostCapacityIsConsistent,
        "Live Valibot validation additionally requires free host capacity not to exceed total capacity.",
    ],
    [
        cacheEntryIsConsistent,
        "Live Valibot validation additionally requires cache projection, attempt, failure, and freshness fields to agree.",
    ],
    [
        cacheEntryStatusIsConsistent,
        "Live Valibot validation additionally requires payload-free cache status fields to agree.",
    ],
    [
        cacheStatusEntriesAreCanonical,
        "Live Valibot validation additionally requires strict ascending cache-key order.",
    ],
    [
        cacheStatusResultIsConsistent,
        "Live Valibot validation additionally requires cache totals, truncation, snapshot timestamps, and freshness relative to the snapshot clock to agree.",
    ],
    [
        cacheHeartbeatConnectionIsConsistent,
        "Live Valibot validation additionally requires the compact Gateway phase and connection freshness to agree.",
    ],
    [
        cacheHeartbeatSessionsLastKnownGoodIsConsistent,
        "Live Valibot validation additionally requires compact Gateway-session staleness to begin at or after the last observation.",
    ],
    [
        cacheHeartbeatCronLastKnownGoodIsConsistent,
        "Live Valibot validation additionally requires compact OpenClaw-cron staleness to begin at or after the last observation.",
    ],
    [
        cacheHeartbeatResultIsConsistent,
        "Live Valibot validation additionally requires nested heartbeat observations not to exceed the clamped response clock and cached projections not to remain fresh while Gateway is disconnected.",
    ],
    [
        cacheRealtimeIdentityMatches,
        "Live Valibot validation additionally requires the realtime entity and compact cache key to match exactly.",
    ],
    [
        agentDefinitionsHaveUniqueIds,
        "Live Valibot validation additionally requires every reviewed agent ID to be unique.",
    ],
    [
        workingStatusTimeIsConsistent,
        "Live Valibot validation additionally requires working-status activity not to precede task start.",
    ],
    [
        agentStatusProjectionIsConsistent,
        "Live Valibot validation additionally keeps Dashboard task state and Gateway session availability separate and requires the fields implied by each state.",
    ],
    [
        activeRunTimeIsConsistent,
        "Live Valibot validation additionally requires active-run activity not to precede task start.",
    ],
    [
        completedRunTimeIsConsistent,
        "Live Valibot validation additionally requires ordered start, activity, and completion timestamps.",
    ],
    [
        newestAgentTaskRunOrderIsStable,
        "Live Valibot validation additionally requires strict newest-first agent task-run ordering by start timestamp and ID.",
    ],
    [
        agentTaskHistoryCursorIsConsistent,
        "Live Valibot validation additionally requires an agent task-history cursor to identify the returned last row.",
    ],
    [
        canonicalAgentStatuses,
        "Live Valibot validation additionally requires one canonically ordered status per configured agent ID.",
    ],
    [
        jobPayloadFitsBudget,
        "Live Valibot validation additionally limits the serialized job payload to its reviewed UTF-8 byte budget.",
    ],
    [
        jobRunResultFitsBudget,
        "Live Valibot validation additionally limits the serialized job result to its reviewed UTF-8 byte budget.",
    ],
    [
        jobRunEventProgressFitsBudget,
        "Live Valibot validation additionally limits serialized job progress to its reviewed UTF-8 byte budget.",
    ],
    [
        jobResourceKeysAreCanonical,
        "Live Valibot validation additionally requires resource keys to be unique, strictly sorted, and within their aggregate UTF-8 byte budget.",
    ],
    [
        scheduleCronExpressionIsValid,
        "Live Valibot validation additionally requires a valid five-field minute cron with a future occurrence.",
    ],
    [
        scheduleTimeZoneIsCanonical,
        "Live Valibot validation additionally requires UTC or a canonical IANA time-zone identifier.",
    ],
    [
        jobRunSummaryIsConsistent,
        "Live Valibot validation additionally requires run provenance, attempts, state, cancellation, and timestamps to agree.",
    ],
    [
        jobRunEventMessageFitsBudget,
        "Live Valibot validation additionally limits the job-event message to its reviewed UTF-8 byte budget.",
    ],
    [
        jobRunEventIsConsistent,
        "Live Valibot validation additionally requires job-event payload fields to agree with the event kind.",
    ],
    [
        jobWorkerSummaryIsConsistent,
        "Live Valibot validation additionally requires worker capacity and lifecycle timestamps to agree.",
    ],
    [
        activeJobDisableIntentTimesAreConsistent,
        "Live Valibot validation additionally requires disable-intent expiry after creation.",
    ],
    [
        scheduleSummaryIsConsistent,
        "Live Valibot validation additionally binds schedule state to its cursor, disable intent, and embedded runs.",
    ],
    [
        newestJobRunOrderIsStable,
        "Live Valibot validation additionally requires strict newest-first job-run ordering by queue timestamp and ID.",
    ],
    [
        activeJobResourceClassesAreCanonical,
        "Live Valibot validation additionally requires active resource classes in canonical unique order.",
    ],
    [
        jobWorkerSummariesAreCanonical,
        "Live Valibot validation additionally requires unique workers in canonical ID order.",
    ],
    [
        jobQueueSummaryIsConsistent,
        "Live Valibot validation additionally binds queue-derived fields to their exact state counts.",
    ],
    [
        jobRunPageCursorIsConsistent,
        "Live Valibot validation additionally requires a job-run cursor to identify the returned last row.",
    ],
    [
        newestJobRunEventOrderIsStable,
        "Live Valibot validation additionally requires strict newest-first job-event sequence order.",
    ],
    [
        jobRunDetailIsConsistent,
        "Live Valibot validation additionally binds job result, events, cursor, and run state.",
    ],
    [
        jobRealtimeIdentityMatches,
        "Live Valibot validation additionally requires the realtime entity and compact payload IDs to match exactly.",
    ],
    [
        scheduleOrderIsStable,
        "Live Valibot validation additionally requires strict ascending schedule ID order.",
    ],
    [
        schedulePageCursorIsConsistent,
        "Live Valibot validation additionally requires a schedule cursor to identify the returned last row.",
    ],
    [
        scheduleUpdatePatchIsConsistent,
        "Live Valibot validation additionally requires a non-empty schedule patch with an explicit disable transition.",
    ],
    [
        scheduleRunPageCursorIsConsistent,
        "Live Valibot validation additionally requires a schedule-run cursor to identify the returned last row.",
    ],
    [
        monitoringJsonObjectFitsBudget,
        "Live Valibot validation additionally limits the serialized JSON object to its reviewed UTF-8 byte budget.",
    ],
    [
        completeMonitoringSnapshotTimesAreConsistent,
        "Live Valibot validation additionally requires snapshot completion not to precede snapshot start.",
    ],
    [
        completeMonitoringSnapshotFitsBudget,
        "Live Valibot validation additionally limits the complete snapshot to its reviewed aggregate UTF-8 byte budget.",
    ],
    [
        activeIncidentTimesAreConsistent,
        "Live Valibot validation additionally requires active-incident observation timestamps to be monotonic.",
    ],
    [
        resolvedIncidentTimesAreConsistent,
        "Live Valibot validation additionally requires resolved-incident observation and resolution timestamps to be monotonic.",
    ],
    [
        activeIncidentSummaryTimesAreConsistent,
        "Live Valibot validation additionally requires active-incident summary timestamps to be monotonic.",
    ],
    [
        resolvedIncidentSummaryTimesAreConsistent,
        "Live Valibot validation additionally requires resolved-incident summary timestamps to be monotonic.",
    ],
    [
        notificationIncidentReferenceIsConsistent,
        "Live Valibot validation additionally requires notification incident ID and generation to be present together.",
    ],
    [
        notificationTimesAreConsistent,
        "Live Valibot validation additionally requires notification read time not to precede occurrence time.",
    ],
    [
        newestIncidentOrderIsStable,
        "Live Valibot validation additionally requires strict newest-first incident ordering by last-seen timestamp and ID.",
    ],
    [
        incidentPageCursorIsConsistent,
        "Live Valibot validation additionally requires an incident continuation cursor to identify the returned last row.",
    ],
    [
        newestNotificationOrderIsStable,
        "Live Valibot validation additionally requires strict newest-first notification ordering by occurrence timestamp and ID.",
    ],
    [
        notificationPageCursorIsConsistent,
        "Live Valibot validation additionally requires a notification continuation cursor to identify the returned last row.",
    ],
    [
        notificationInputIncidentReferenceIsConsistent,
        "Live Valibot validation additionally requires producer incident ID and generation to be present together.",
    ],
    [
        newestReportOrderIsStable,
        "Live Valibot validation additionally requires strict newest-first report ordering by occurrence timestamp and ID.",
    ],
    [
        reportPageCursorIsConsistent,
        "Live Valibot validation additionally requires a report continuation cursor to identify the returned last row.",
    ],
    [
        upsertReportInputFitsBudget,
        "Live Valibot validation additionally limits report producer input to its reviewed aggregate UTF-8 byte budget.",
    ],
    [
        automationCredentialTimesAreOrdered,
        "Live Valibot validation additionally requires credential expiry after creation and revocation no earlier than creation.",
    ],
    [
        automationCredentialDoesNotReplaceItself,
        "Live Valibot validation additionally requires a replacement credential to reference a different credential ID.",
    ],
    [
        automationPrincipalTimesAreOrdered,
        "Live Valibot validation additionally orders principal creation, update, and disable timestamps.",
    ],
    [
        automationPrincipalCredentialCountsAreConsistent,
        "Live Valibot validation additionally bounds active credentials by the total and requires zero active credentials when disabled.",
    ],
    [
        automationPrincipalRowsHaveStableOrder,
        "Live Valibot validation additionally requires strict newest-first ordering by creation timestamp and ID.",
    ],
    [
        automationCredentialRowsHaveStableOrder,
        "Live Valibot validation additionally requires strict newest-first ordering by creation timestamp and ID.",
    ],
    [
        automationPrincipalPageCountsAreConsistent,
        "Live Valibot validation additionally requires principal page and active counts not to exceed the total count.",
    ],
    [
        automationPrincipalPageCursorIsConsistent,
        "Live Valibot validation additionally requires a principal continuation cursor to identify the returned last row.",
    ],
    [
        automationCredentialPageCountIsConsistent,
        "Live Valibot validation additionally requires the credential page count not to exceed the total count.",
    ],
    [
        automationCredentialPageCursorIsConsistent,
        "Live Valibot validation additionally requires a credential continuation cursor to identify the returned last row.",
    ],
    [
        createdAutomationPrincipalResultIsConsistent,
        "Live Valibot validation additionally binds a new principal to one active initial credential and its matching one-time token prefix.",
    ],
    [
        createdAutomationCredentialResultIsConsistent,
        "Live Valibot validation additionally requires a new standalone credential and matching one-time token prefix.",
    ],
    [
        rotatedAutomationCredentialResultIsConsistent,
        "Live Valibot validation additionally requires a staged predecessor link and matching one-time token prefix.",
    ],
    [
        revokedAutomationCredentialResultIsConsistent,
        "Live Valibot validation additionally requires every revoke result to include its durable revocation timestamp.",
    ],
    [
        disabledAutomationPrincipalResultIsConsistent,
        "Live Valibot validation additionally requires terminal disabled state and zero newly revoked credentials for an idempotent no-op.",
    ],
    [
        securityAuditEventsHaveStableOrder,
        "Live Valibot validation additionally requires strict newest-first audit-event ordering by occurrence timestamp and ID.",
    ],
    [
        securityAuditPageCursorIsConsistent,
        "Live Valibot validation additionally requires an audit continuation cursor to identify the returned last event.",
    ],
    [
        taskTextIsTrimmed,
        "Live Valibot validation additionally requires compact task text to have canonical outer whitespace.",
    ],
    [
        taskStringsAreSorted,
        "Live Valibot validation additionally requires task strings to use canonical code-unit order.",
    ],
    [
        taskTimesAreOrdered,
        "Live Valibot validation additionally requires task update timestamps not to precede creation.",
    ],
    [
        taskDetailTimesAreOrdered,
        "Live Valibot validation additionally requires task update timestamps not to precede creation.",
    ],
    [
        taskProgressTimesAreOrdered,
        "Live Valibot validation additionally requires progress update timestamps not to precede creation.",
    ],
    [
        newestTaskOrderIsStable,
        "Live Valibot validation additionally requires strict newest-first task ordering by update timestamp and ID.",
    ],
    [
        taskPageCursorIsConsistent,
        "Live Valibot validation additionally requires a task continuation cursor to identify the returned last row.",
    ],
    [
        newestProgressOrderIsStable,
        "Live Valibot validation additionally requires strict newest-first progress ordering by creation timestamp and ID.",
    ],
    [
        taskProgressPageCursorIsConsistent,
        "Live Valibot validation additionally requires a progress continuation cursor to identify the returned last row.",
    ],
]);

function appendJsonSchemaComment(
    jsonSchema: object,
    comment: string
): Record<string, unknown> {
    const existing =
        "$comment" in jsonSchema
            ? (jsonSchema as { readonly $comment?: unknown }).$comment
            : undefined;
    return {
        ...jsonSchema,
        $comment:
            typeof existing === "string" && existing.length > 0
                ? `${existing} ${comment}`
                : comment,
    };
}

function appendJsonSchemaPattern(
    jsonSchema: object,
    pattern: string
): Record<string, unknown> {
    const existingPattern =
        "pattern" in jsonSchema && typeof jsonSchema.pattern === "string"
            ? jsonSchema.pattern
            : undefined;
    if (existingPattern === undefined) return { ...jsonSchema, pattern };

    const existingAllOfValue: unknown = Reflect.get(jsonSchema, "allOf");
    const existingAllOf: readonly unknown[] = Array.isArray(existingAllOfValue)
        ? (existingAllOfValue as unknown[])
        : [];
    return {
        ...jsonSchema,
        allOf: [...existingAllOf, { pattern }],
    };
}

function readActionRequirement(action: unknown): unknown {
    return typeof action === "object" && action !== null && "requirement" in action
        ? (action as Record<string, unknown>).requirement
        : undefined;
}

function readActionOperation(action: unknown): unknown {
    return typeof action === "object" && action !== null && "operation" in action
        ? (action as Record<string, unknown>).operation
        : undefined;
}

/**
 * Converts a Valibot transport contract into deterministic JSON Schema.
 * @param schema Valibot source schema.
 * @param schemaId Stable contract schema ID.
 * @param typeMode Whether input or output types are documented.
 * @returns JSON Schema draft 2020-12 document.
 */
export function convertContractSchema(
    schema: ContractSchema,
    schemaId: string,
    typeMode: SchemaTypeMode
): Record<string, unknown> {
    return {
        $id: `urn:mira-dashboard:${schemaId}`,
        ...toJsonSchema(schema, {
            errorMode: "throw",
            overrideSchema({ jsonSchema, valibotSchema }) {
                if (valibotSchema === jsonObjectSchema) {
                    return appendJsonSchemaComment(
                        { ...jsonSchema, type: "object" },
                        "Live Valibot validation additionally requires an acyclic plain JSON object with bounded depth, finite safe-magnitude numbers, and no sparse arrays."
                    );
                }
                return null;
            },
            overrideAction({ jsonSchema, valibotAction }) {
                const requirement = readActionRequirement(valibotAction);
                const operation = readActionOperation(valibotAction);
                // JSON Schema carries a pattern but no flags. The transport uses
                // Unicode mode only for ASCII-bounded expressions, for which
                // dropping the flag does not change accepted values.
                if (
                    valibotAction.type === "regex" &&
                    requirement instanceof RegExp &&
                    requirement.flags === "u"
                ) {
                    return {
                        ...jsonSchema,
                        pattern: requirement.source,
                    };
                }
                // This exact named refinement is equivalent to draft-2020-12's
                // uniqueItems keyword. Every other unsupported check still fails.
                if (
                    valibotAction.type === "check" &&
                    requirement === hasValidAuthPasswordLength
                ) {
                    return {
                        ...jsonSchema,
                        maxLength: authPasswordMaximumLength,
                        minLength: authPasswordMinimumLength,
                    };
                }
                if (
                    valibotAction.type === "check" &&
                    requirement === isValidBrowserSessionUserAgent
                ) {
                    return {
                        ...jsonSchema,
                        maxLength: browserSessionUserAgentMaximumLength,
                        minLength: 1,
                        pattern: "^(?=[\\s\\S]*\\S)[^\\u0000]*$",
                    };
                }
                if (
                    valibotAction.type === "check" &&
                    requirement === isValidSecurityLabel
                ) {
                    return {
                        ...jsonSchema,
                        maxLength: securityLabelMaximumLength,
                        minLength: 1,
                        pattern: securityLabelJsonSchemaPattern,
                    };
                }
                if (
                    valibotAction.type === "check" &&
                    requirement === hasUniqueArrayItems
                ) {
                    return { ...jsonSchema, uniqueItems: true };
                }
                if (valibotAction.type === "check" && requirement === hasNoNulCharacter) {
                    return appendJsonSchemaPattern(jsonSchema, noNulJsonSchemaPattern);
                }
                if (
                    valibotAction.type === "check" &&
                    requirement === hasNoUnicodeControlOrFormat
                ) {
                    return appendJsonSchemaPattern(
                        jsonSchema,
                        controlSafeTextJsonSchemaPattern
                    );
                }
                if (
                    valibotAction.type === "check" &&
                    requirement === taskPatchHasChange
                ) {
                    return { ...jsonSchema, minProperties: 1 };
                }
                if (valibotAction.type === "check") {
                    const maximumLength =
                        getBoundedNonBlankTextMaximumLength(requirement);
                    if (maximumLength !== undefined) {
                        return {
                            ...jsonSchema,
                            maxLength: maximumLength,
                            minLength: 1,
                        };
                    }
                }
                if (
                    valibotAction.type === "check" &&
                    requirement === isCanonicalWebAuthnBase64Url
                ) {
                    return {
                        ...jsonSchema,
                        pattern:
                            "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048])?$",
                    };
                }
                // Draft 2020-12 has no portable sibling-field equality keyword.
                // The generated schema retains the strict structural bounds while
                // Valibot enforces id === rawId at the live trust boundary.
                if (
                    valibotAction.type === "check" &&
                    (requirement === hasMatchingWebAuthnRegistrationCredentialIds ||
                        requirement === hasMatchingWebAuthnAuthenticationCredentialIds)
                ) {
                    return {
                        ...jsonSchema,
                        $comment:
                            "Live Valibot validation additionally requires id and rawId to match exactly.",
                    };
                }
                if (
                    valibotAction.type === "check" &&
                    requirement === hasValidPossessionFactorInventory
                ) {
                    return {
                        ...jsonSchema,
                        $comment:
                            "Live Valibot validation additionally limits the combined TOTP and WebAuthn possession-factor inventory to four.",
                    };
                }
                if (
                    valibotAction.type === "check" &&
                    requirement === bulkNotificationContinuationIsConsistent
                ) {
                    const existingAllOfValue: unknown = Reflect.get(jsonSchema, "allOf");
                    const existingAllOf: readonly unknown[] = Array.isArray(
                        existingAllOfValue
                    )
                        ? (existingAllOfValue as unknown[])
                        : [];
                    const continuationSchema: Record<string, unknown> = {
                        if: {
                            properties: { remaining: { const: true } },
                            required: ["remaining"],
                        },
                    };
                    Reflect.set(continuationSchema, "then", {
                        properties: {
                            affectedCount: {
                                const: notificationPageMaximum,
                            },
                        },
                        required: ["affectedCount"],
                    });
                    return {
                        ...jsonSchema,
                        allOf: [...existingAllOf, continuationSchema],
                    };
                }
                if (valibotAction.type === "check") {
                    const comment = runtimeCheckComments.get(requirement);
                    if (comment !== undefined) {
                        return appendJsonSchemaComment(jsonSchema, comment);
                    }
                }
                // JSON Schema validates the same unique bounded set. Canonical
                // ordering is a runtime output normalization, not an input rule.
                if (
                    valibotAction.type === "transform" &&
                    (operation === sortWebAuthnTransports ||
                        operation === sortApplicationCapabilities ||
                        operation === canonicalAgentDefinitions ||
                        operation === canonicalizeTaskStrings ||
                        operation === freezeTaskStrings ||
                        operation === normalizeScheduleCronExpression ||
                        operation === normalizeChatSpeechSynthesisText ||
                        operation === normalizeChatAttachmentTicketFile)
                ) {
                    return jsonSchema;
                }
                return null;
            },
            target: "draft-2020-12",
            typeMode,
        }),
    };
}
