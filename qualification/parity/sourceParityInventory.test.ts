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

async function withModifiedRouter(
    modifyRouter: (source: string) => string,
    verify: (temporaryRepositoryRoot: string) => Promise<void>
): Promise<void> {
    const temporaryRepositoryRoot = await mkdtemp(
        path.join(tmpdir(), "mira-parity-router-")
    );
    try {
        await Promise.all(
            Object.values(paritySourcePaths).map(async (relativePath) => {
                const destination = path.join(temporaryRepositoryRoot, relativePath);
                await mkdir(path.dirname(destination), { recursive: true });
                await copyFile(path.join(repositoryRoot, relativePath), destination);
            })
        );
        const routerPath = path.join(temporaryRepositoryRoot, paritySourcePaths.router);
        const routerSource = await readFile(routerPath, "utf8");
        await writeFile(routerPath, modifyRouter(routerSource), "utf8");
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
    await withModifiedRouter(
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
    await withModifiedRouter(
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
    await withModifiedRouter(
        (source) => replaceExactly(source, '    path: "/login",', "    path: loginPath,"),
        (temporaryRepositoryRoot) =>
            expectInventoryLoadFailure(
                temporaryRepositoryRoot,
                "Route loginRoute path changed outside the reviewed literal shape"
            )
    );
});

test("rejects a createRoute declaration outside the reviewed block shape", async () => {
    await withModifiedRouter(
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
    await withModifiedRouter(
        (source) =>
            replaceExactly(source, "        settingsRoute,", "        loginRoute,"),
        (temporaryRepositoryRoot) =>
            expectInventoryLoadFailure(
                temporaryRepositoryRoot,
                "Reviewed route tree identifiers differ"
            )
    );
});
