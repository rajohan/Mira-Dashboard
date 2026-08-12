import { accountSecurityProcedureContracts } from "./accountSecurity.ts";
import { agentRealtimeEventContract } from "./agentRealtime.ts";
import { agentProcedureContracts } from "./agents.ts";
import { authProcedureContracts } from "./auth.ts";
import { automationSecurityProcedureContracts } from "./automationSecurity.ts";
import { cacheProcedureContracts } from "./cache.ts";
import { cacheRealtimeEventContract } from "./cacheRealtime.ts";
import { chatProcedureContracts } from "./chat.ts";
import { chatRawHttpContracts } from "./chatMedia.ts";
import {
    chatHistoryRealtimeEventContract,
    chatRealtimeEventContract,
} from "./chatRealtime.ts";
import { chatSpeechRawHttpContracts } from "./chatSpeech.ts";
import { eventsStreamContract } from "./events.ts";
import {
    workspaceFileProcedureContracts,
    workspaceFileRawHttpContracts,
} from "./files.ts";
import { gatewayConnectionProcedureContracts } from "./gatewayConnection.ts";
import { gatewayRealtimeEventContracts } from "./gatewayRealtime.ts";
import { gatewaySessionProcedureContracts } from "./gatewaySessions.ts";
import { incidentProcedureContracts } from "./incidents.ts";
import { jobRealtimeEventContracts } from "./jobRealtime.ts";
import { jobProcedureContracts } from "./jobs.ts";
import { logProcedureContracts } from "./logs.ts";
import { moltbookProcedureContracts } from "./moltbook.ts";
import { monitoringProcedureContracts } from "./monitoringIngestion.ts";
import { monitoringRealtimeEventContracts } from "./monitoringRealtime.ts";
import { notificationProcedureContracts } from "./notifications.ts";
import { openClawCronProcedureContracts } from "./openClawCron.ts";
import {
    openClawSettingsProcedureContracts,
    openClawSettingsRawHttpContracts,
} from "./openClawSettings.ts";
import { openClawTaskProcedureContracts } from "./openClawTasks.ts";
import { openClawTasksRealtimeEventContract } from "./openClawTasksRealtime.ts";
import {
    assertProcedureContractErrors,
    type ProcedureContract,
    type RawHttpContract,
    type RealtimeEventContract,
} from "./registry.ts";
import { reportProcedureContracts } from "./reports.ts";
import { scheduleProcedureContracts } from "./schedules.ts";
import { securityAuditProcedureContracts } from "./securityAudit.ts";
import { systemProcedureContracts, systemRawHttpContracts } from "./system.ts";
import { taskRealtimeEventContract } from "./taskRealtime.ts";
import { taskProcedureContracts } from "./tasks.ts";
import { terminalProcedureContracts, terminalRawHttpContracts } from "./terminal.ts";

/** Implemented tRPC procedure metadata used by runtime wiring and docs. */
const registeredProcedureContracts = [
    ...accountSecurityProcedureContracts,
    ...agentProcedureContracts,
    ...authProcedureContracts,
    ...automationSecurityProcedureContracts,
    ...cacheProcedureContracts,
    ...chatProcedureContracts,
    eventsStreamContract,
    ...workspaceFileProcedureContracts,
    ...gatewayConnectionProcedureContracts,
    ...gatewaySessionProcedureContracts,
    ...incidentProcedureContracts,
    ...jobProcedureContracts,
    ...logProcedureContracts,
    ...monitoringProcedureContracts,
    ...moltbookProcedureContracts,
    ...notificationProcedureContracts,
    ...openClawSettingsProcedureContracts,
    ...openClawTaskProcedureContracts,
    ...openClawCronProcedureContracts,
    ...reportProcedureContracts,
    ...scheduleProcedureContracts,
    ...securityAuditProcedureContracts,
    ...systemProcedureContracts,
    ...taskProcedureContracts,
    ...terminalProcedureContracts,
] as const satisfies readonly ProcedureContract[];

/** Exact registered procedure union used by environment-neutral typed clients. */
export type RegisteredProcedureContract = (typeof registeredProcedureContracts)[number];
assertProcedureContractErrors(registeredProcedureContracts);
export const procedureContracts = Object.freeze(
    registeredProcedureContracts.map((registeredContract) => {
        const contract: ProcedureContract = registeredContract;
        const access =
            "capabilities" in contract.access
                ? Object.freeze({
                      ...contract.access,
                      capabilities: Object.freeze([
                          ...(contract.access.capabilities ?? []),
                      ]),
                      ...(contract.access.principalKinds === undefined
                          ? {}
                          : {
                                principalKinds: Object.freeze([
                                    ...contract.access.principalKinds,
                                ]),
                            }),
                  })
                : Object.freeze({ ...contract.access });
        return Object.freeze({
            ...contract,
            access,
            ...(contract.errorReasons === undefined
                ? {}
                : { errorReasons: Object.freeze([...contract.errorReasons]) }),
            errors: Object.freeze([...contract.errors]),
            transport: Object.freeze({ ...contract.transport }),
        });
    })
);

/** Implemented raw HTTP metadata used by runtime wiring and docs. */
export const rawHttpContracts: readonly RawHttpContract[] = [
    ...chatRawHttpContracts,
    ...chatSpeechRawHttpContracts,
    ...workspaceFileRawHttpContracts,
    ...openClawSettingsRawHttpContracts,
    ...systemRawHttpContracts,
    ...terminalRawHttpContracts,
];

/** Implemented realtime topics used by runtime wiring and docs. */
export const realtimeEventContracts: readonly RealtimeEventContract[] = Object.freeze([
    agentRealtimeEventContract,
    cacheRealtimeEventContract,
    chatHistoryRealtimeEventContract,
    chatRealtimeEventContract,
    ...gatewayRealtimeEventContracts,
    ...jobRealtimeEventContracts,
    ...monitoringRealtimeEventContracts,
    openClawTasksRealtimeEventContract,
    taskRealtimeEventContract,
]);
