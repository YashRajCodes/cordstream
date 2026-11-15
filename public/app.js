import { handleAction } from "./js/actions.js";
import { renderLogin, renderShell } from "./js/render.js";
import { state } from "./js/state.js";
import { app } from "./js/ui.js";

app.addEventListener("click", (event) => {
  const element = event.target.closest("[data-action]");
  if (!element) return;
  const action = element.dataset.action;
  if (action === "stream-link") event.preventDefault();
  void handleAction(action, element.dataset.id, element);
});

async function start() {
  try {
    const response = await fetch("/api/auth/status");
    const data = await response.json();
    if (!data.authenticated) {
      const error = new URLSearchParams(window.location.search).get("auth_error");
      renderLogin(error ? "Discord login failed. Try again." : "");
      return;
    }
    state.user = data.user;
    state.guilds = data.guilds ?? [];
    state.demo = Boolean(data.demo);
    renderShell();
  } catch {
    renderLogin("Could not connect. Try again.");
  }
}

void start();
