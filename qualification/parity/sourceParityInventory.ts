import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type {
    FrontendRouteInventory,
    LegacyEndpointInventory,
} from "./parityInventorySchemas.ts";

const maximumSourceBytes = 2 * 1024 * 1024;

export const paritySourcePaths = {
    endpoints: "docs/api/endpoints.md",
    navigation: "frontend/src/components/layout/Layout.tsx",
    routeModules: "frontend/src/lib/routeModules.ts",
    router: "frontend/src/router.tsx",
} as const;

type SourceFrontendRoute = Omit<FrontendRouteInventory, "featureOwner" | "target">;
type SourceLegacyEndpoint = Omit<LegacyEndpointInventory, "target">;

export interface SourceParityInventory {
    endpoints: SourceLegacyEndpoint[];
    routes: SourceFrontendRoute[];
}

interface NavigationEntry {
    label: string;
    path: string;
    position: number;
}

interface RouteModuleEntry {
    key: string;
    pageModule: string;
}

interface LazyComponentEntry {
    component: string;
    moduleKey: string;
}

interface PreloadEntry {
    moduleKey: string;
    path: string;
}

interface RouteEntry {
    access: "public" | "session";
    component: string;
    path: string;
    searchNormalizer: SourceFrontendRoute["searchNormalizer"];
    sourceRouteName: string;
}

interface RouteDeclaration {
    block: string;
    identifier: string;
    sourceRouteName: string;
}

const reviewedPathlessRoutes = {
    authenticatedRoute: {
        id: "authenticated",
        parent: "rootRoute",
    },
} as const;
const routeIdentifierSuffix = "Route";

function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function requiredBlock(source: string, pattern: RegExp, context: string): string {
    const block = source.match(pattern)?.[1];
    if (!block) throw new Error(`Cannot locate reviewed ${context}`);
    return block;
}

function extractNavigationEntries(source: string): NavigationEntry[] {
    const block = requiredBlock(
        source,
        /^const navItems = \[\n([\s\S]*?)^\];$/mu,
        "navigation array"
    );
    const entries = [
        ...block.matchAll(
            /^\s{4}\{ to: "([^"]+)", icon: [A-Za-z][A-Za-z0-9]*, label: "([^"]+)" \},$/gmu
        ),
    ].map((match, position) => ({
        label: match[2]!,
        path: match[1]!,
        position,
    }));
    if (entries.length === 0) throw new Error("Reviewed navigation has no literal items");
    const remaining = block.replaceAll(
        /^\s{4}\{ to: "([^"]+)", icon: [A-Za-z][A-Za-z0-9]*, label: "([^"]+)" \},\n?/gmu,
        ""
    );
    if (remaining.trim()) {
        throw new Error("Reviewed navigation contains an unrecognized item shape");
    }
    return entries;
}

function extractRouteModules(source: string): RouteModuleEntry[] {
    const block = requiredBlock(
        source,
        /^export const routeModules = \{\n([\s\S]*?)^\};$/mu,
        "route module registry"
    );
    const entries = [
        ...block.matchAll(/^\s{4}([a-z][A-Za-z0-9]*): \(\) => import\("([^"]+)"\),$/gmu),
    ].map((match) => ({ key: match[1]!, pageModule: match[2]! }));
    const remaining = block.replaceAll(
        /^\s{4}([a-z][A-Za-z0-9]*): \(\) => import\("([^"]+)"\),\n?/gmu,
        ""
    );
    if (entries.length === 0 || remaining.trim()) {
        throw new Error(
            "Reviewed route module registry changed outside the literal shape"
        );
    }
    return entries;
}

function extractPreloadEntries(source: string): PreloadEntry[] {
    const block = requiredBlock(
        source,
        /^const routeModulesByPath: Readonly<Record<string, RouteModuleLoader>> = \{\n([\s\S]*?)^\};$/mu,
        "route preload registry"
    );
    const entries = [
        ...block.matchAll(/^\s{4}"([^"]+)": routeModules\.([a-z][A-Za-z0-9]*),$/gmu),
    ].map((match) => ({ moduleKey: match[2]!, path: match[1]! }));
    const remaining = block.replaceAll(
        /^\s{4}"([^"]+)": routeModules\.([a-z][A-Za-z0-9]*),\n?/gmu,
        ""
    );
    if (entries.length === 0 || remaining.trim()) {
        throw new Error(
            "Reviewed route preload registry changed outside the literal shape"
        );
    }
    return entries;
}

function extractLazyComponents(source: string): LazyComponentEntry[] {
    return [
        ...source.matchAll(
            /^const ([A-Z][A-Za-z0-9]*) = lazyRouteComponent\(\n\s*\(\) => loadLazyModule\("route-[a-z-]+", routeModules\.([a-z][A-Za-z0-9]*)\),\n\s*"\1"\n\);$/gmu
        ),
    ].map((match) => ({ component: match[1]!, moduleKey: match[2]! }));
}

function extractRouteDeclarations(source: string): RouteDeclaration[] {
    const createRouteCallCount = [...source.matchAll(/\bcreateRoute\s*\(/gu)].length;
    const declaredIdentifiers = [
        ...source.matchAll(/^const ([a-z][A-Za-z0-9]*Route) = createRoute\s*\(/gmu),
    ].map((match) => match[1]!);
    if (createRouteCallCount !== declaredIdentifiers.length) {
        throw new Error(
            "Reviewed router contains a createRoute call outside the reviewed declaration shape"
        );
    }

    const declarations = [
        ...source.matchAll(
            /^const ([a-z][A-Za-z0-9]*Route) = createRoute\(\{\n([\s\S]*?)^\}\);$/gmu
        ),
    ].map((match): RouteDeclaration => ({
        block: match[2]!,
        identifier: match[1]!,
        sourceRouteName: match[1]!.slice(0, -routeIdentifierSuffix.length),
    }));
    if (
        declarations.length !== declaredIdentifiers.length ||
        declarations.some(
            (declaration, index) => declaration.identifier !== declaredIdentifiers[index]
        )
    ) {
        throw new Error(
            "Reviewed router createRoute declarations changed outside the reviewed literal shape"
        );
    }
    if (new Set(declaredIdentifiers).size !== declaredIdentifiers.length) {
        throw new Error("Reviewed router contains duplicate createRoute declarations");
    }
    if (declarations.length === 0) {
        throw new Error("Reviewed router has no literal createRoute declarations");
    }
    return declarations;
}

function assertReviewedPathlessRoute(declaration: RouteDeclaration): void {
    const review =
        reviewedPathlessRoutes[
            declaration.identifier as keyof typeof reviewedPathlessRoutes
        ];
    if (!review) {
        throw new Error(
            `Pathless route ${declaration.identifier} is not explicitly reviewed`
        );
    }
    const parent = declaration.block.match(
        /^\s{4}getParentRoute: \(\) => ([a-z][A-Za-z0-9]*Route),$/mu
    )?.[1];
    const routeId = declaration.block.match(/^\s{4}id: "([^"]+)",$/mu)?.[1];
    const rendersAuthenticatedLayout =
        /^\s{4}component: \(\) => \(\n\s{8}<Layout>\n\s{12}<Outlet \/>\n\s{8}<\/Layout>\n\s{4}\),$/mu.test(
            declaration.block
        );
    const enforcesAuthenticatedSession =
        /^\s{4}beforeLoad: async \(\) => \{\n\s{8}await authActions\.initialize\(\);\n\s{8}if \(!authStore\.state\.isAuthenticated\) \{\n\s{12}redirect\(\{ throw: true, to: "\/login" \}\);\n\s{8}\}\n\s{4}\},$/mu.test(
            declaration.block
        );
    if (
        parent !== review.parent ||
        routeId !== review.id ||
        !enforcesAuthenticatedSession ||
        !rendersAuthenticatedLayout
    ) {
        throw new Error(
            `Pathless route ${declaration.identifier} changed outside its explicit review`
        );
    }
}

function assertExactRouteTreeIdentifiers(
    source: string,
    declarations: readonly RouteDeclaration[]
): void {
    const routeTree = requiredBlock(
        source,
        /^const routeTree = ([\s\S]*?)^\/\*\* Defines router\. \*\/$/mu,
        "route tree"
    );
    const observedIdentifiers = [...routeTree.matchAll(/\b([a-z][A-Za-z0-9]*Route)\b/gu)]
        .map((match) => match[1]!)
        .toSorted(compareStrings);
    const expectedIdentifiers = [
        "rootRoute",
        ...declarations.map((declaration) => declaration.identifier),
    ].toSorted(compareStrings);
    if (
        observedIdentifiers.length !== expectedIdentifiers.length ||
        observedIdentifiers.some(
            (identifier, index) => identifier !== expectedIdentifiers[index]
        )
    ) {
        throw new Error(
            `Reviewed route tree identifiers differ: expected ${expectedIdentifiers.join(
                ", "
            )}; observed ${observedIdentifiers.join(", ")}`
        );
    }
}

function extractRoutes(source: string): RouteEntry[] {
    const declarations = extractRouteDeclarations(source);
    const routes: RouteEntry[] = [];
    for (const declaration of declarations) {
        const literalPaths = [
            ...declaration.block.matchAll(/^\s{4}path: "([^"]+)",$/gmu),
        ];
        if (literalPaths.length === 0) {
            if (/^\s{4}path\s*:/mu.test(declaration.block)) {
                throw new Error(
                    `Route ${declaration.identifier} path changed outside the reviewed literal shape`
                );
            }
            assertReviewedPathlessRoute(declaration);
            continue;
        }
        if (literalPaths.length !== 1) {
            throw new Error(`Route ${declaration.identifier} has multiple literal paths`);
        }
        if (declaration.identifier in reviewedPathlessRoutes) {
            throw new Error(
                `Explicitly reviewed pathless route ${declaration.identifier} now has a path`
            );
        }
        const routePath = literalPaths[0]![1]!;
        const parent = declaration.block.match(
            /^\s{4}getParentRoute: \(\) => (rootRoute|authenticatedRoute),$/mu
        )?.[1];
        const component = declaration.block.match(
            /^\s{4}component: ([A-Z][A-Za-z0-9]*),$/mu
        )?.[1];
        if (!parent || !component) {
            throw new Error(
                `Route ${declaration.identifier} changed outside the reviewed shape`
            );
        }
        const normalizer = declaration.block.match(
            /^\s{4}validateSearch: (normalizeChatSearch|normalizeSettingsSearch),$/mu
        )?.[1];
        routes.push({
            access: parent === "rootRoute" ? "public" : "session",
            component,
            path: routePath,
            searchNormalizer:
                normalizer === "normalizeChatSearch" ||
                normalizer === "normalizeSettingsSearch"
                    ? normalizer
                    : null,
            sourceRouteName: declaration.sourceRouteName,
        });
    }
    if (routes.length === 0) throw new Error("Reviewed router has no literal routes");
    assertExactRouteTreeIdentifiers(source, declarations);
    return routes;
}

function buildFrontendSourceInventory(
    routerSource: string,
    navigationSource: string,
    routeModulesSource: string
): SourceFrontendRoute[] {
    const routes = extractRoutes(routerSource);
    const lazyComponents = extractLazyComponents(routerSource);
    const routeModules = extractRouteModules(routeModulesSource);
    const preloadEntries = extractPreloadEntries(routeModulesSource);
    const navigation = extractNavigationEntries(navigationSource);
    const navigationPaths = new Set<string>();
    for (const item of navigation) {
        if (navigationPaths.has(item.path)) {
            throw new Error(`Duplicate reviewed navigation path ${item.path}`);
        }
        navigationPaths.add(item.path);
    }
    const routePaths = new Set(routes.map((route) => route.path));
    for (const item of navigation) {
        if (!routePaths.has(item.path)) {
            throw new Error(`Navigation path ${item.path} has no reviewed route`);
        }
    }
    const usedModuleKeys = new Set<string>();
    const inventory = routes.map((route): SourceFrontendRoute => {
        const lazyComponent = lazyComponents.find(
            (candidate) => candidate.component === route.component
        );
        if (!lazyComponent) {
            throw new Error(`Route ${route.path} has no reviewed lazy component`);
        }
        const routeModule = routeModules.find(
            (candidate) => candidate.key === lazyComponent.moduleKey
        );
        if (!routeModule) {
            throw new Error(`Route ${route.path} has no reviewed route module`);
        }
        usedModuleKeys.add(routeModule.key);
        const navigationItem = navigation.find((item) => item.path === route.path);
        const preloadEntry = preloadEntries.find((entry) => entry.path === route.path);
        if (
            navigationItem &&
            (!preloadEntry || preloadEntry.moduleKey !== routeModule.key)
        ) {
            throw new Error(
                `Navigation path ${route.path} has no matching route preload`
            );
        }
        if (!navigationItem && preloadEntry) {
            throw new Error(
                `Non-navigation route ${route.path} has an unreviewed preload`
            );
        }
        return {
            access: route.access,
            moduleKey: routeModule.key,
            navigationLabel: navigationItem?.label ?? null,
            navigationPosition: navigationItem?.position ?? null,
            pageModule: routeModule.pageModule,
            path: route.path,
            searchNormalizer: route.searchNormalizer,
            sourceRouteName: route.sourceRouteName,
        };
    });
    if (usedModuleKeys.size !== routeModules.length) {
        const unused = routeModules
            .filter((routeModule) => !usedModuleKeys.has(routeModule.key))
            .map((routeModule) => routeModule.key)
            .join(", ");
        throw new Error(`Reviewed route modules are not routed: ${unused}`);
    }
    if (preloadEntries.length !== navigation.length) {
        throw new Error("Reviewed route preload and navigation counts differ");
    }
    return inventory.toSorted((left, right) => compareStrings(left.path, right.path));
}

function parseLegacyEndpointRows(markdown: string): SourceLegacyEndpoint[] {
    let section = "";
    const endpoints: SourceLegacyEndpoint[] = [];
    for (const line of markdown.split("\n")) {
        const sectionMatch = line.match(/^## (.+)$/u);
        if (sectionMatch?.[1]) {
            section = sectionMatch[1];
            continue;
        }
        const row = line.match(
            /^\|\s*`?(DELETE|GET|HEAD|PATCH|POST|PUT|WebSocket)`?\s*\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|$/u
        );
        if (!row) continue;
        if (!section) throw new Error("Legacy endpoint row has no section");
        const method = row[1]! as SourceLegacyEndpoint["method"];
        const endpointPath = row[2]!;
        endpoints.push({
            id: `${method} ${endpointPath}`,
            method,
            path: endpointPath,
            purpose: row[3]!,
            section,
        });
    }
    const sorted = endpoints.toSorted((left, right) => compareStrings(left.id, right.id));
    for (const [index, endpoint] of sorted.entries()) {
        if (index > 0 && sorted[index - 1]!.id === endpoint.id) {
            throw new Error(`Duplicate legacy endpoint row ${endpoint.id}`);
        }
    }
    return sorted;
}

async function readBoundedUtf8(
    repositoryRoot: string,
    relativePath: string
): Promise<string> {
    const absolutePath = path.resolve(repositoryRoot, relativePath);
    const relative = path.relative(repositoryRoot, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Parity source path escaped the repository root");
    }
    const sourceStat = await stat(absolutePath);
    if (
        !sourceStat.isFile() ||
        sourceStat.size <= 0 ||
        sourceStat.size > maximumSourceBytes
    ) {
        throw new Error(`Parity source ${relativePath} has an invalid size`);
    }
    return readFile(absolutePath, "utf8");
}

/**
 * Loads the semantic current-production parity inventory from reviewed repository sources.
 * @param repositoryRoot Absolute repository root.
 * @returns Current route, navigation, module, and endpoint source inventory.
 */
export async function loadSourceParityInventory(
    repositoryRoot: string
): Promise<SourceParityInventory> {
    const [endpointMarkdown, navigationSource, routeModulesSource, routerSource] =
        await Promise.all([
            readBoundedUtf8(repositoryRoot, paritySourcePaths.endpoints),
            readBoundedUtf8(repositoryRoot, paritySourcePaths.navigation),
            readBoundedUtf8(repositoryRoot, paritySourcePaths.routeModules),
            readBoundedUtf8(repositoryRoot, paritySourcePaths.router),
        ]);
    return {
        endpoints: parseLegacyEndpointRows(endpointMarkdown),
        routes: buildFrontendSourceInventory(
            routerSource,
            navigationSource,
            routeModulesSource
        ),
    };
}
