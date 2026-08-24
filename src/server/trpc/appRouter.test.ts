import { describe, expect, test } from "bun:test";

import { procedureContracts } from "../../contracts/contractRegistry.ts";
import { appRouter } from "./appRouter.ts";

describe("application router", () => {
    test("matches the registered procedure contract keys exactly", () => {
        const contractNames = procedureContracts.map(({ name }) => name).toSorted();
        const routerNames = Object.keys(appRouter._def.procedures).toSorted();

        expect(routerNames).toEqual(contractNames);
    });
});
