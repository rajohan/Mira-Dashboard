import { createLazyRoute } from "@tanstack/react-router";

import { LoginRoute } from "../auth/LoginRoute.tsx";

export const Route = createLazyRoute("/login")({ component: LoginRoute });
