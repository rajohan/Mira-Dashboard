import {
    BookOpen,
    Bot,
    CalendarClock,
    Database,
    Boxes,
    FolderOpen,
    Home,
    ListTodo,
    Logs,
    MessageCircle,
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
        { icon: Bot, label: "Agents", to: "/agents" },
        { icon: MessagesSquare, label: "Sessions", to: "/sessions" },
        { icon: MessageCircle, label: "Chat", to: "/chat" },
        { icon: FolderOpen, label: "Files", to: "/files" },
        { icon: ListTodo, label: "Tasks", to: "/tasks" },
        { icon: CalendarClock, label: "Jobs", to: "/jobs" },
        { icon: Logs, label: "Logs", to: "/logs" },
        { icon: Database, label: "Database", to: "/database" },
        { icon: Boxes, label: "Docker", to: "/docker" },
        { icon: BookOpen, label: "Moltbook", to: "/moltbook" },
        { icon: SquareTerminal, label: "Terminal", to: "/terminal" },
        { icon: Newspaper, label: "Reports", to: "/reports" },
        { icon: Settings, label: "Settings", to: "/settings" },
    ]
);
