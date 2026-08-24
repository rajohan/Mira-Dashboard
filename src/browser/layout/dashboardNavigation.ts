import {
    BookOpen,
    Bot,
    CalendarClock,
    Database,
    BookMarked,
    Boxes,
    FolderOpen,
    GitPullRequest,
    Home,
    ListTodo,
    Logs,
    MessageSquare,
    MessagesSquare,
    Newspaper,
    Settings,
    SquareTerminal,
    type LucideIcon,
} from "lucide-react";

import type { DashboardNavigationPath } from "../lib/dashboardRoutes.ts";

interface DashboardNavigationItem {
    readonly icon: LucideIcon;
    readonly label: string;
    readonly to: DashboardNavigationPath;
}

/** Main authenticated navigation in reviewed display order. */
export const dashboardNavigationItems: readonly DashboardNavigationItem[] = Object.freeze(
    [
        { icon: Home, label: "Dashboard", to: "/" },
        { icon: ListTodo, label: "Tasks", to: "/tasks" },
        { icon: Bot, label: "Agents", to: "/agents" },
        { icon: MessagesSquare, label: "Sessions", to: "/sessions" },
        { icon: MessageSquare, label: "Chat", to: "/chat" },
        { icon: Newspaper, label: "Reports", to: "/reports" },
        { icon: CalendarClock, label: "Jobs", to: "/jobs" },
        { icon: GitPullRequest, label: "Delivery", to: "/delivery" },
        { icon: FolderOpen, label: "Files", to: "/files" },
        { icon: Boxes, label: "Docker", to: "/docker" },
        { icon: Database, label: "Database", to: "/database" },
        { icon: BookOpen, label: "Moltbook", to: "/moltbook" },
        { icon: SquareTerminal, label: "Terminal", to: "/terminal" },
        { icon: Logs, label: "Logs", to: "/logs" },
        { icon: Settings, label: "Settings", to: "/settings" },
        { icon: BookMarked, label: "Docs", to: "/docs" },
    ]
);
