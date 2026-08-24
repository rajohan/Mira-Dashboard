import { assertProductionBootstrapConfiguration } from "../server/platform/configuration/productionBootstrapConfigurationCheck.ts";
import {
    environmentSource,
    type ApplicationEnvironmentSource,
} from "./environmentSource.ts";

type EnvironmentSource = (role: "web" | "worker") => ApplicationEnvironmentSource;

/** Projects only registered role keys before applying both production parsers. */
export function assertProductionBootstrapEnvironmentSources(
    source: EnvironmentSource = environmentSource
): void {
    assertProductionBootstrapConfiguration({
        ...source("web"),
        ...source("worker"),
    });
}

if (import.meta.main) assertProductionBootstrapEnvironmentSources();
