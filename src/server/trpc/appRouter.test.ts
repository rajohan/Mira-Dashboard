import { describe, expect, test } from "bun:test";

import { procedureContracts } from "../../contracts/contractRegistry.ts";
import { appRouterProcedureNames } from "./appRouter.ts";

describe("application router", () => {
    test("matches the registered procedure contract keys exactly", () => {
        const contractNames = procedureContracts.map(({ name }) => name).toSorted();
        const routerNames = appRouterProcedureNames.toSorted();

        expect(routerNames).toEqual(contractNames);
    });

    test("exposes the exact automation-security namespace inventory", () => {
        expect(
            appRouterProcedureNames
                .filter((name) => name.startsWith("automationSecurity."))
                .toSorted()
        ).toEqual(
            [
                "automationSecurity.createCredential",
                "automationSecurity.createPrincipal",
                "automationSecurity.disablePrincipal",
                "automationSecurity.listCredentials",
                "automationSecurity.listPrincipals",
                "automationSecurity.replaceCapabilities",
                "automationSecurity.revokeCredential",
                "automationSecurity.rotateCredential",
            ].toSorted()
        );
    });
});
