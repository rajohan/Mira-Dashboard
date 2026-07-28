type RouteModuleLoader = () => Promise<unknown>;

export const routeModules = {
    agents: () => import("../pages/Agents"),
    chat: () => import("../pages/Chat"),
    dashboard: () => import("../pages/Dashboard"),
    database: () => import("../pages/Database"),
    delivery: () => import("../pages/Delivery"),
    docker: () => import("../pages/Docker"),
    files: () => import("../pages/Files"),
    jobs: () => import("../pages/Jobs"),
    login: () => import("../pages/Login"),
    logs: () => import("../pages/Logs"),
    moltbook: () => import("../pages/Moltbook"),
    reports: () => import("../pages/Reports"),
    sessions: () => import("../pages/Sessions"),
    settings: () => import("../pages/Settings"),
    tasks: () => import("../pages/Tasks"),
    terminal: () => import("../pages/Terminal"),
};

const routeModulesByPath: Readonly<Record<string, RouteModuleLoader>> = {
    "/": routeModules.dashboard,
    "/agents": routeModules.agents,
    "/chat": routeModules.chat,
    "/database": routeModules.database,
    "/delivery": routeModules.delivery,
    "/docker": routeModules.docker,
    "/files": routeModules.files,
    "/jobs": routeModules.jobs,
    "/logs": routeModules.logs,
    "/moltbook": routeModules.moltbook,
    "/reports": routeModules.reports,
    "/sessions": routeModules.sessions,
    "/settings": routeModules.settings,
    "/tasks": routeModules.tasks,
    "/terminal": routeModules.terminal,
};

/** Warms a module without turning a speculative preload failure into navigation. */
export async function preloadModule(load: RouteModuleLoader): Promise<void> {
    try {
        await load();
    } catch {
        // A committed navigation retries through loadLazyModule and may recover.
    }
}

/** Preloads a registered route from hover/focus intent without reloading the page. */
export function preloadRouteModule(pathname: string): void {
    const load = routeModulesByPath[pathname];
    if (load) void preloadModule(load);
}
