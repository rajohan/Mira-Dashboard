import { createLink } from "@tanstack/react-router";

import { ActionAnchor } from "./actionAnchor.tsx";

/**
 * Renders a typed same-origin router link with shared interaction styling.
 * @returns A TanStack Router link supporting route params, search, hash, and action variants.
 */
export const ActionLink = createLink(ActionAnchor);
