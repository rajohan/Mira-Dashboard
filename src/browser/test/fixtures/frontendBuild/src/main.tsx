import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import FixtureApp from "./FixtureApp";

createRoot(document.querySelector("#root")!).render(
    <StrictMode>
        <FixtureApp />
    </StrictMode>
);
