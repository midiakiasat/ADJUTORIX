import React from "react";
import { createRoot } from "react-dom/client";
import NativeControlPlaneWorkbench from "./NativeControlPlaneWorkbench";
import "./native-workbench.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("ADJUTORIX_RENDERER_ROOT_MISSING");

createRoot(rootElement).render(
  <React.StrictMode>
    <NativeControlPlaneWorkbench />
  </React.StrictMode>,
);
