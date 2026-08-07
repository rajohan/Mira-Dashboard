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

test("rejects duplicate procedure names and invalid error metadata", () => {
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

    expect(() =>
        assertProcedureContractErrors([
            { errors: [], name: "duplicate" },
            { errors: [], name: "duplicate" },
        ])
    ).toThrow("Procedure contract names must be unique");
});

test("deeply freezes registered procedure policy metadata", () => {
    expect(Object.isFrozen(procedureContracts)).toBe(true);
    for (const contract of procedureContracts) {
        expect(Object.isFrozen(contract)).toBe(true);
        expect(Object.isFrozen(contract.access)).toBe(true);
        expect(Object.isFrozen(contract.errors)).toBe(true);
        expect(Object.isFrozen(contract.transport)).toBe(true);
        if ("capabilities" in contract.access) {
            expect(Object.isFrozen(contract.access.capabilities)).toBe(true);
        }
        if (contract.errorReasons !== undefined) {
            expect(Object.isFrozen(contract.errorReasons)).toBe(true);
        }
    }
});
