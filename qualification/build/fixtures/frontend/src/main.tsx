import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import QualificationApp from "./QualificationApp";

createRoot(document.querySelector("#root")!).render(
    <StrictMode>
        <QualificationApp />
    </StrictMode>
);
