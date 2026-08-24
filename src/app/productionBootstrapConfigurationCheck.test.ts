import { expect, test } from "bun:test";

import { assertProductionBootstrapEnvironmentSources } from "./productionBootstrapConfigurationCheck.ts";

test("projects both registered production role environments", () => {
    const roles: string[] = [];
    expect(() =>
        assertProductionBootstrapEnvironmentSources((role) => {
            roles.push(role);
            return {};
        })
    ).toThrow();
    expect(roles).toEqual(["web", "worker"]);
});
