import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSourceParityInventory, paritySourcePaths } from "./sourceParityInventory.ts";

const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
);

function replaceExactly(source: string, target: string, replacement: string): string {
    const parts = source.split(target);
    if (parts.length !== 2) {
        throw new Error(`Expected one source occurrence of ${JSON.stringify(target)}`);
    }
    return `${parts[0]}${replacement}${parts[1]}`;
}

async function withModifiedSource(
    relativeSourcePath: (typeof paritySourcePaths)[keyof typeof paritySourcePaths],
    modifySource: (source: string) => string,
    verify: (temporaryRepositoryRoot: string) => Promise<void>
): Promise<void> {
    const temporaryRepositoryRoot = await mkdtemp(
        path.join(tmpdir(), "mira-parity-source-")
    );
    try {
        await Promise.all(
            Object.values(paritySourcePaths).map(async (relativePath) => {
                const destination = path.join(temporaryRepositoryRoot, relativePath);
                await mkdir(path.dirname(destination), { recursive: true });
                await copyFile(path.join(repositoryRoot, relativePath), destination);
            })
        );
        const sourcePath = path.join(temporaryRepositoryRoot, relativeSourcePath);
        const source = await readFile(sourcePath, "utf8");
        await writeFile(sourcePath, modifySource(source), "utf8");
        await verify(temporaryRepositoryRoot);
    } finally {
        await rm(temporaryRepositoryRoot, { force: true, recursive: true });
    }
}

async function expectInventoryLoadFailure(
    temporaryRepositoryRoot: string,
    expectedMessage: string
): Promise<void> {
    try {
        await loadSourceParityInventory(temporaryRepositoryRoot);
    } catch (error) {
        if (!(error instanceof Error)) throw error;
        expect(error.message).toContain(expectedMessage);
        return;
    }
    throw new Error(`Expected parity inventory loading to fail with ${expectedMessage}`);
}

test("allows the explicitly reviewed authenticated pathless layout", async () => {
    const inventory = await loadSourceParityInventory(repositoryRoot);
    expect(inventory.routes).toHaveLength(16);
    expect(
        inventory.routes.some(
            ({ sourceRouteName }) => sourceRouteName === "authenticated"
        )
    ).toBeFalse();
});

test("rejects a pathless layout whose authentication guard is weakened", async () => {
    await withModifiedSource(
        paritySourcePaths.router,
        (source) =>
            replaceExactly(
                source,
                "        if (!authStore.state.isAuthenticated) {",
                "        if (false) {"
            ),
        (temporaryRepositoryRoot) =>
            expectInventoryLoadFailure(
                temporaryRepositoryRoot,
                "Pathless route authenticatedRoute changed outside its explicit review"
            )
    );
});

test("rejects an unreviewed pathless createRoute declaration", async () => {
    await withModifiedSource(
        paritySourcePaths.router,
        (source) =>
            replaceExactly(
                source,
                "const routeTree = rootRoute.addChildren([",
                `const hiddenRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "hidden",
    component: Login,
});

const routeTree = rootRoute.addChildren([`
            ),
        (temporaryRepositoryRoot) =>
            expectInventoryLoadFailure(
                temporaryRepositoryRoot,
                "Pathless route hiddenRoute is not explicitly reviewed"
            )
    );
});

test("rejects a createRoute path that is no longer a reviewed literal", async () => {
    await withModifiedSource(
        paritySourcePaths.router,
        (source) => replaceExactly(source, '    path: "/login",', "    path: loginPath,"),
        (temporaryRepositoryRoot) =>
            expectInventoryLoadFailure(
                temporaryRepositoryRoot,
                "Route loginRoute path changed outside the reviewed literal shape"
            )
    );
});

test("rejects a createRoute declaration outside the reviewed block shape", async () => {
    await withModifiedSource(
        paritySourcePaths.router,
        (source) =>
            replaceExactly(
                source,
                "const loginRoute = createRoute({",
                "const loginRoute = createRoute( {"
            ),
        (temporaryRepositoryRoot) =>
            expectInventoryLoadFailure(
                temporaryRepositoryRoot,
                "Reviewed router createRoute declarations changed outside the reviewed literal shape"
            )
    );
});

test("rejects routeTree identifiers that do not exactly match declarations", async () => {
    await withModifiedSource(
        paritySourcePaths.router,
        (source) =>
            replaceExactly(source, "        settingsRoute,", "        loginRoute,"),
        (temporaryRepositoryRoot) =>
            expectInventoryLoadFailure(
                temporaryRepositoryRoot,
                "Reviewed route tree identifiers differ"
            )
    );
});

test("rejects a routeTree child identifier without the Route suffix", async () => {
    await withModifiedSource(
        paritySourcePaths.router,
        (source) =>
            replaceExactly(
                source,
                "        settingsRoute,",
                "        settingsRoute,\n        settingsPage,"
            ),
        (temporaryRepositoryRoot) =>
            expectInventoryLoadFailure(
                temporaryRepositoryRoot,
                "Reviewed route tree identifiers differ"
            )
    );
});

test("rejects unrecognized routeTree syntax", async () => {
    await withModifiedSource(
        paritySourcePaths.router,
        (source) =>
            replaceExactly(
                source,
                "    loginRoute,",
                "    loginRoute,\n    ...conditionallyIncludedRoutes,"
            ),
        (temporaryRepositoryRoot) =>
            expectInventoryLoadFailure(
                temporaryRepositoryRoot,
                "Reviewed route tree contains unrecognized syntax"
            )
    );
});

test("rejects navigation entries outside the reviewed literal shape", async () => {
    await withModifiedSource(
        paritySourcePaths.navigation,
        (source) =>
            replaceExactly(
                source,
                '    { to: "/", icon: Home, label: "Dashboard" },',
                '    { to: "/", icon: Home, label: "Dashboard", unreviewed: true },'
            ),
        (temporaryRepositoryRoot) =>
            expectInventoryLoadFailure(
                temporaryRepositoryRoot,
                "Reviewed navigation contains an unrecognized item shape"
            )
    );
});

test("rejects route modules outside the reviewed literal shape", async () => {
    await withModifiedSource(
        paritySourcePaths.routeModules,
        (source) =>
            replaceExactly(
                source,
                '    agents: () => import("../pages/Agents"),',
                '    agents: () => import("../pages/Agents") ,'
            ),
        (temporaryRepositoryRoot) =>
            expectInventoryLoadFailure(
                temporaryRepositoryRoot,
                "Reviewed route module registry changed outside the literal shape"
            )
    );
});

test("rejects preload entries outside the reviewed literal shape", async () => {
    await withModifiedSource(
        paritySourcePaths.routeModules,
        (source) =>
            replaceExactly(
                source,
                '    "/agents": routeModules.agents,',
                '    "/agents": routeModules.agents ,'
            ),
        (temporaryRepositoryRoot) =>
            expectInventoryLoadFailure(
                temporaryRepositoryRoot,
                "Reviewed route preload registry changed outside the literal shape"
            )
    );
});
