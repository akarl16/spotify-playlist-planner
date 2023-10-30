import { StrictMode } from "react";
// import ReactDOM from "react-dom";
import { createRoot } from 'react-dom/client';

import App from "./App";

const queryParams = new URLSearchParams(window.location.search);
const strictParam = queryParams.get("strict");

const container = document.getElementById("root");
const root = createRoot(container);
if (strictParam) {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} else {
  root.render(
    <App />
  );
}