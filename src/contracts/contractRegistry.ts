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
export const procedureContracts = Object.freeze(registeredProcedureContracts);

/** Implemented raw HTTP metadata used by runtime wiring and docs. */
export const rawHttpContracts: readonly RawHttpContract[] = [...systemRawHttpContracts];

/** Implemented realtime topics used by runtime wiring and docs. */
export const realtimeEventContracts: readonly RealtimeEventContract[] = [];
