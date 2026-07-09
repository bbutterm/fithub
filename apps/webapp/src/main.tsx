import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, initTelegram } from "./telegram";
import "./styles.css";

initTelegram();
applyTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
