import type {
    ProcedureContract,
    RawHttpContract,
    RealtimeEventContract,
} from "./registry.ts";
import { systemProcedureContracts, systemRawHttpContracts } from "./system.ts";

/** Implemented tRPC procedure metadata used by runtime wiring and docs. */
export const procedureContracts: readonly ProcedureContract[] = [
    ...systemProcedureContracts,
];

/** Implemented raw HTTP metadata used by runtime wiring and docs. */
export const rawHttpContracts: readonly RawHttpContract[] = [...systemRawHttpContracts];

/** Implemented realtime topics used by runtime wiring and docs. */
export const realtimeEventContracts: readonly RealtimeEventContract[] = [];
