import {
    type ApplicationConfigurationEnvironmentName,
    type ApplicationProcessRole,
    configurationEnvironmentNamesForRole,
} from "../shared/configuration/applicationConfigurationRegistry.ts";

export type ApplicationEnvironmentSource = Readonly<
    Partial<Record<ApplicationConfigurationEnvironmentName, string | undefined>>
>;

/**
 * Reads only registered process-environment keys for a process composition root.
 * The source-boundary gate permits imports only from the web and worker roots.
 * @param role Web or worker composition role.
 * @returns Frozen, null-prototype projection of that role's registered environment surface.
 */
export function environmentSource(
    role: Extract<ApplicationProcessRole, "web" | "worker">
): ApplicationEnvironmentSource {
    const environment = Object.create(null) as Partial<
        Record<ApplicationConfigurationEnvironmentName, string | undefined>
    >;
    for (const environmentName of configurationEnvironmentNamesForRole(role)) {
        environment[environmentName] = process.env[environmentName];
    }
    return Object.freeze(environment);
}
