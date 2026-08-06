import * as v from "valibot";

/* oxlint-disable unicorn/max-nested-calls -- Strict Valibot schemas are intentionally declarative. */

const schemaVersionSchema = v.literal(1);
const boundedTextSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(512));
const procedureNameSchema = v.pipe(
    v.string(),
    v.regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/u)
);
const routePathSchema = v.pipe(
    v.string(),
    v.regex(
        /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*)?$/u
    )
);
const rawHttpPathSchema = v.pipe(
    v.string(),
    v.regex(/^\/api\/[A-Za-z0-9._~!$&'()+,;=:@%*/-]+$/u)
);
const phaseSchema = v.picklist([
    "phase-1",
    "phase-2",
    "phase-3",
    "phase-4",
    "phase-5",
    "phase-6",
]);
const deliverySchema = v.picklist(["implemented", "planned"]);
const sourceMethodSchema = v.picklist([
    "DELETE",
    "GET",
    "HEAD",
    "PATCH",
    "POST",
    "PUT",
    "WebSocket",
]);
const rawHttpMethodSchema = v.picklist(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"]);

export const reviewedLegacyEndpointRowCount = 157;

function valuesAreSortedAndUnique(values: string[]): boolean {
    return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

const procedureTargetSchema = v.strictObject({
    delivery: deliverySchema,
    kind: v.literal("procedure"),
    names: v.pipe(
        v.array(procedureNameSchema),
        v.minLength(1),
        v.maxLength(4),
        v.check(valuesAreSortedAndUnique, "Procedure names must be sorted and unique")
    ),
    phase: phaseSchema,
});

const rawHttpTargetSchema = v.strictObject({
    delivery: deliverySchema,
    kind: v.literal("raw-http"),
    method: rawHttpMethodSchema,
    path: rawHttpPathSchema,
    phase: phaseSchema,
});

const reviewedRemovalTargetSchema = v.strictObject({
    consumerEvidence: v.literal("no-current-consumers"),
    kind: v.literal("reviewed-removal"),
    reason: boundedTextSchema,
});

export const endpointTargetSchema = v.variant("kind", [
    procedureTargetSchema,
    rawHttpTargetSchema,
    reviewedRemovalTargetSchema,
]);

const legacyEndpointSchema = v.strictObject({
    id: v.pipe(v.string(), v.minLength(6), v.maxLength(256)),
    method: sourceMethodSchema,
    path: v.pipe(v.string(), v.startsWith("/"), v.maxLength(192)),
    purpose: boundedTextSchema,
    section: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
    target: endpointTargetSchema,
});

const frontendRouteSchema = v.strictObject({
    access: v.picklist(["public", "session"]),
    featureOwner: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]*$/u)),
    moduleKey: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9]*$/u)),
    navigationLabel: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(32))),
    navigationPosition: v.nullable(
        v.pipe(v.number(), v.integer(), v.safeInteger(), v.minValue(0), v.maxValue(64))
    ),
    pageModule: v.pipe(v.string(), v.regex(/^\.\.\/pages\/[A-Z][A-Za-z0-9]*$/u)),
    path: routePathSchema,
    searchNormalizer: v.nullable(
        v.picklist(["normalizeChatSearch", "normalizeSettingsSearch"])
    ),
    sourceRouteName: v.pipe(v.string(), v.regex(/^[a-z][A-Za-z0-9]*$/u)),
    target: v.strictObject({
        delivery: v.literal("planned"),
        path: routePathSchema,
        phase: phaseSchema,
    }),
});

const contentPolicySchema = v.strictObject({
    containsHostConfiguration: v.literal(false),
    containsRuntimeState: v.literal(false),
    containsSecrets: v.literal(false),
    sourceBacked: v.literal(true),
});

export const frontendParityFixtureSchema = v.pipe(
    v.strictObject({
        contentPolicy: contentPolicySchema,
        routes: v.pipe(
            v.array(frontendRouteSchema),
            v.minLength(1),
            v.maxLength(64),
            v.check(
                (routes) => valuesAreSortedAndUnique(routes.map((route) => route.path)),
                "Frontend routes must be sorted and unique"
            ),
            v.check(
                (routes) =>
                    valuesAreSortedAndUnique(
                        routes
                            .filter((route) => route.navigationPosition !== null)
                            .toSorted(
                                (left, right) =>
                                    left.navigationPosition! - right.navigationPosition!
                            )
                            .map((route) =>
                                String(route.navigationPosition).padStart(3, "0")
                            )
                    ),
                "Navigation positions must be unique"
            ),
            v.check(
                (routes) =>
                    routes.every(
                        (route) =>
                            (route.navigationLabel === null) ===
                            (route.navigationPosition === null)
                    ),
                "Navigation labels and positions must both be present or absent"
            )
        ),
        schemaVersion: schemaVersionSchema,
        sources: v.strictObject({
            navigation: v.literal("frontend/src/components/layout/Layout.tsx"),
            routeModules: v.literal("frontend/src/lib/routeModules.ts"),
            router: v.literal("frontend/src/router.tsx"),
        }),
    }),
    v.check(
        (fixture) => fixture.routes.every((route) => route.path === route.target.path),
        "Current public route paths must remain stable in the target inventory"
    )
);

export const legacyEndpointParityFixtureSchema = v.pipe(
    v.strictObject({
        contentPolicy: contentPolicySchema,
        endpoints: v.pipe(
            v.array(legacyEndpointSchema),
            v.minLength(1),
            v.maxLength(256),
            v.check(
                (endpoints) =>
                    valuesAreSortedAndUnique(endpoints.map((endpoint) => endpoint.id)),
                "Legacy endpoint ids must be sorted and unique"
            ),
            v.check(
                (endpoints) =>
                    endpoints.every(
                        (endpoint) =>
                            endpoint.id === `${endpoint.method} ${endpoint.path}`
                    ),
                "Legacy endpoint ids must be derived from method and path"
            )
        ),
        schemaVersion: schemaVersionSchema,
        sources: v.strictObject({
            documentation: v.literal("docs/api/endpoints.md"),
            httpRegistry: v.literal("backend/src/routes/registry.ts"),
            websocket: v.literal("backend/src/server/app.ts"),
        }),
    }),
    v.check(
        (fixture) => fixture.endpoints.length === reviewedLegacyEndpointRowCount,
        `The reviewed legacy endpoint inventory must contain exactly ${reviewedLegacyEndpointRowCount} rows`
    )
);

const greenfieldProcedureIdentitySchema = v.strictObject({
    kind: v.picklist(["mutation", "query", "subscription"]),
    name: procedureNameSchema,
});

const greenfieldRawHttpIdentitySchema = v.strictObject({
    id: v.pipe(v.string(), v.minLength(6), v.maxLength(256)),
    method: rawHttpMethodSchema,
    path: rawHttpPathSchema,
});

export const greenfieldContractParityFixtureSchema = v.strictObject({
    contentPolicy: contentPolicySchema,
    procedures: v.pipe(
        v.array(greenfieldProcedureIdentitySchema),
        v.minLength(1),
        v.maxLength(256),
        v.check(
            (procedures) =>
                valuesAreSortedAndUnique(procedures.map((procedure) => procedure.name)),
            "Greenfield procedure identities must be sorted and unique"
        )
    ),
    rawHttp: v.pipe(
        v.array(greenfieldRawHttpIdentitySchema),
        v.minLength(1),
        v.maxLength(64),
        v.check(
            (contracts) =>
                valuesAreSortedAndUnique(contracts.map((contract) => contract.id)),
            "Greenfield raw HTTP identities must be sorted and unique"
        ),
        v.check(
            (contracts) =>
                contracts.every(
                    (contract) => contract.id === `${contract.method} ${contract.path}`
                ),
            "Greenfield raw HTTP ids must be derived from method and path"
        )
    ),
    schemaVersion: schemaVersionSchema,
    source: v.literal("src/contracts/contractRegistry.ts"),
});

export type EndpointTarget = v.InferOutput<typeof endpointTargetSchema>;
export type FrontendParityFixture = v.InferOutput<typeof frontendParityFixtureSchema>;
export type FrontendRouteInventory = FrontendParityFixture["routes"][number];
export type LegacyEndpointParityFixture = v.InferOutput<
    typeof legacyEndpointParityFixtureSchema
>;
export type LegacyEndpointInventory = LegacyEndpointParityFixture["endpoints"][number];
export type GreenfieldContractParityFixture = v.InferOutput<
    typeof greenfieldContractParityFixtureSchema
>;

/**
 * Parses one strict frontend parity fixture.
 * @param value Candidate fixture value.
 * @returns Validated frontend parity fixture.
 */
export function parseFrontendParityFixture(value: unknown): FrontendParityFixture {
    return v.parse(frontendParityFixtureSchema, value);
}

/**
 * Parses one strict legacy endpoint parity fixture.
 * @param value Candidate fixture value.
 * @returns Validated legacy endpoint parity fixture.
 */
export function parseLegacyEndpointParityFixture(
    value: unknown
): LegacyEndpointParityFixture {
    return v.parse(legacyEndpointParityFixtureSchema, value);
}

/**
 * Parses one strict greenfield contract identity fixture.
 * @param value Candidate fixture value.
 * @returns Validated greenfield contract identity fixture.
 */
export function parseGreenfieldContractParityFixture(
    value: unknown
): GreenfieldContractParityFixture {
    return v.parse(greenfieldContractParityFixtureSchema, value);
}
