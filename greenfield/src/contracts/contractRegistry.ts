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
import { systemProcedureContracts, systemRawHttpContracts } from "./system.ts";

/** Implemented tRPC procedure metadata used by runtime wiring and docs. */
const registeredProcedureContracts: readonly ProcedureContract[] = [
    ...accountSecurityProcedureContracts,
    ...authProcedureContracts,
    ...automationSecurityProcedureContracts,
    eventsStreamContract,
    ...systemProcedureContracts,
];
assertProcedureContractErrors(registeredProcedureContracts);
export const procedureContracts = Object.freeze(
    registeredProcedureContracts.map((contract) => {
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
