import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { Outlet, useLocation } from "@tanstack/react-router";
import {
    Bot,
    CalendarClock,
    FolderOpen,
    Home,
    ListTodo,
    Logs,
    Menu,
    MessageCircle,
    MessagesSquare,
    Newspaper,
    ShieldCheck,
    SquareTerminal,
    X,
    type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "../lib/classNames.ts";
import type {
    DashboardAuthenticatedPath,
    DashboardNavigationPath,
} from "../lib/dashboardRoutes.ts";
import { Icon } from "../ui/Icon.tsx";
import { IconOnlyButton } from "../ui/IconOnlyButton.tsx";
import { NavigationLink } from "../ui/NavigationLink.tsx";
import { DashboardHeaderControls } from "./DashboardHeaderControls.tsx";
import {
    dashboardMainClassName,
    dashboardPageContainerClassName,
} from "./dashboardShellLayout.ts";

interface NavigationItem {
    readonly icon: LucideIcon;
    readonly label: string;
    readonly to: DashboardNavigationPath;
}

const navigationItems: readonly NavigationItem[] = Object.freeze([
    { icon: Home, label: "Dashboard", to: "/" },
    { icon: Bot, label: "Agents", to: "/agents" },
    { icon: MessagesSquare, label: "Sessions", to: "/sessions" },
    { icon: MessageCircle, label: "Chat", to: "/chat" },
    { icon: FolderOpen, label: "Files", to: "/files" },
    { icon: ListTodo, label: "Tasks", to: "/tasks" },
    { icon: CalendarClock, label: "Jobs", to: "/jobs" },
    { icon: Logs, label: "Logs", to: "/logs" },
    { icon: SquareTerminal, label: "Terminal", to: "/terminal" },
    { icon: Newspaper, label: "Reports", to: "/reports" },
    { icon: ShieldCheck, label: "Account security", to: "/account-security" },
]);
const routeTitles: readonly Pick<NavigationItem, "label" | "to">[] = Object.freeze([
    ...navigationItems,
]);
const authenticatedRouteTitles: readonly {
    readonly label: string;
    readonly to: DashboardAuthenticatedPath;
}[] = Object.freeze([...routeTitles, { label: "Incidents", to: "/incidents" }]);
const dashboardTopBarClassName = "border-primary-700 h-16 shrink-0 border-b";

interface NavigationProps {
    readonly currentPath: string;
    readonly onNavigate?: () => void;
}

function Navigation({ currentPath, onNavigate }: NavigationProps) {
    return (
        <nav aria-label="Main navigation" className="flex-1 p-2">
            {navigationItems.map((item) => {
                const active = currentPath === item.to;
                return (
                    <NavigationLink
                        active={active}
                        key={item.to}
                        onClick={onNavigate}
                        to={item.to}
                    >
                        <Icon icon={item.icon} tone="inherit" />
                        <span>{item.label}</span>
                    </NavigationLink>
                );
            })}
        </nav>
    );
}

interface SidebarContentProps extends NavigationProps {
    readonly onClose?: () => void;
}

function SidebarContent({ currentPath, onClose, onNavigate }: SidebarContentProps) {
    return (
        <>
            <div
                className={cn(
                    dashboardTopBarClassName,
                    "flex items-center justify-between gap-3 px-4"
                )}
            >
                <div className="flex items-center gap-2">
                    <span aria-hidden="true" className="text-2xl">
                        👩‍💻
                    </span>
                    <p className="text-primary-50 text-lg font-bold sm:text-xl">
                        Mira Dashboard
                    </p>
                </div>
                {onClose !== undefined && (
                    <IconOnlyButton
                        icon={X}
                        label="Close navigation menu"
                        onClick={onClose}
                        size="sm"
                        variant="ghost"
                    />
                )}
            </div>
            <Navigation currentPath={currentPath} onNavigate={onNavigate} />
            <div className="border-primary-700 text-primary-400 border-t p-4 text-xs">
                Secure operator workspace
            </div>
        </>
    );
}

/**
 * Renders the persistent Dashboard layout and a focused login canvas.
 * @returns The current route outlet inside its visual application shell.
 */
export function DashboardShell() {
    const location = useLocation();
    const [mobileNavigationPath, setMobileNavigationPath] = useState<string>();
    const mobileNavigationOpen = mobileNavigationPath === location.pathname;

    if (location.pathname === "/login") {
        return (
            <main className="bg-primary-950 text-primary-50 flex h-full min-h-screen items-center justify-center overflow-y-auto px-4 py-10">
                <Outlet />
            </main>
        );
    }

    const currentTitle =
        authenticatedRouteTitles.find((item) => item.to === location.pathname)?.label ??
        "Mira Dashboard";
    const fullHeightCanvas =
        location.pathname === "/chat" || location.pathname === "/terminal";
    return (
        <div className="bg-primary-900 text-primary-50 flex h-full overflow-hidden">
            <a
                className="bg-accent-500 text-primary-950 fixed top-3 left-3 z-60 -translate-y-24 rounded-lg px-3 py-2 font-semibold transition-transform focus:translate-y-0"
                href="#dashboard-content"
            >
                Skip to content
            </a>

            <aside className="border-primary-700 bg-primary-950 hidden w-64 shrink-0 flex-col border-r md:flex">
                <SidebarContent currentPath={location.pathname} />
            </aside>

            <Dialog
                className="relative z-50 md:hidden"
                onClose={() => setMobileNavigationPath(undefined)}
                open={mobileNavigationOpen}
            >
                <DialogBackdrop
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm transition data-closed:opacity-0"
                    transition
                />
                <div className="fixed inset-0 flex">
                    <DialogPanel
                        className="border-primary-700 bg-primary-950 flex w-72 max-w-[85vw] flex-col border-r shadow-2xl shadow-black/50 transition duration-200 data-closed:-translate-x-full"
                        transition
                    >
                        <DialogTitle className="sr-only">
                            Mira Dashboard navigation
                        </DialogTitle>
                        <SidebarContent
                            currentPath={location.pathname}
                            onClose={() => setMobileNavigationPath(undefined)}
                            onNavigate={() => setMobileNavigationPath(undefined)}
                        />
                    </DialogPanel>
                </div>
            </Dialog>

            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <header
                    className={cn(
                        dashboardTopBarClassName,
                        "bg-primary-950 flex items-center gap-3 px-4 sm:px-6"
                    )}
                >
                    <IconOnlyButton
                        className="md:hidden"
                        icon={Menu}
                        label="Open navigation menu"
                        onClick={() => setMobileNavigationPath(location.pathname)}
                        size="sm"
                        variant="ghost"
                    />
                    <p className="text-primary-50 truncate text-lg font-bold sm:text-xl">
                        {currentTitle}
                    </p>
                    <div className="ml-auto min-w-0">
                        <DashboardHeaderControls />
                    </div>
                </header>
                <main
                    className={dashboardMainClassName(location.pathname)}
                    data-scroll-restoration-id="dashboard-content"
                    id="dashboard-content"
                >
                    <div
                        className={cn(
                            "w-full",
                            fullHeightCanvas
                                ? "h-full min-h-0"
                                : dashboardPageContainerClassName
                        )}
                    >
                        <Outlet />
                    </div>
                </main>
            </div>
        </div>
    );
}
