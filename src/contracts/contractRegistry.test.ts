import { expect, test } from "bun:test";

import { procedureContracts } from "./contractRegistry.ts";
import {
    assertProcedureContractErrors,
    contractErrorCodes,
    type ProcedureContract,
} from "./registry.ts";

test("registers one sorted stable expected-error vocabulary", () => {
    expect([...contractErrorCodes]).toEqual([...contractErrorCodes].toSorted());
    expect(new Set(contractErrorCodes).size).toBe(contractErrorCodes.length);
    expect(new Set<string>(contractErrorCodes).has("INTERNAL_SERVER_ERROR")).toBe(false);
    expect(() => assertProcedureContractErrors(procedureContracts)).not.toThrow();
});

test("rejects duplicate, unsorted, and unregistered procedure errors", () => {
    const invalid = [
        { errors: ["UNAUTHORIZED", "FORBIDDEN"], name: "unsorted" },
        { errors: ["FORBIDDEN", "FORBIDDEN"], name: "duplicate" },
        { errors: ["INTERNAL_SERVER_ERROR"], name: "unregistered" },
    ];

    for (const contract of invalid) {
        expect(() =>
            assertProcedureContractErrors([
                contract as unknown as Pick<ProcedureContract, "errors" | "name">,
            ])
        ).toThrow(`Procedure contract errors are invalid for ${contract.name}`);
    }
});
