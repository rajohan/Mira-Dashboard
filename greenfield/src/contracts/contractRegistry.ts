import { accountSecurityProcedureContracts } from "./accountSecurity.ts";
import { authProcedureContracts } from "./auth.ts";
import { automationSecurityProcedureContracts } from "./automationSecurity.ts";
import { eventsStreamContract } from "./events.ts";
import {
    assertProcedureContractErrors,
    type ProcedureContract,
    type RawHttpContract,
    type RealtimeEventContract,
} from "./registry.ts";
import { securityAuditProcedureContracts } from "./securityAudit.ts";
import { systemProcedureContracts, systemRawHttpContracts } from "./system.ts";
import { taskProcedureContracts } from "./tasks.ts";

/** Implemented tRPC procedure metadata used by runtime wiring and docs. */
const registeredProcedureContracts = [
    ...accountSecurityProcedureContracts,
    ...authProcedureContracts,
    ...automationSecurityProcedureContracts,
    eventsStreamContract,
    ...securityAuditProcedureContracts,
    ...systemProcedureContracts,
    ...taskProcedureContracts,
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
                      capabilities: Object.freeze([...contract.access.capabilities]),
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
export const rawHttpContracts: readonly RawHttpContract[] = [...systemRawHttpContracts];

/** Implemented realtime topics used by runtime wiring and docs. */
export const realtimeEventContracts: readonly RealtimeEventContract[] = [];
