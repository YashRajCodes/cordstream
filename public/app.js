import { handleAction, selectGuild } from "./js/actions.js";
import { renderLoading, renderLogin, renderShell } from "./js/render.js";
import { selectedGuild, state } from "./js/state.js";
import { loadStreams, resetStreams } from "./js/streams.js";
import { app, showToast } from "./js/ui.js";

app.addEventListener("click", (event) => {
  const element = event.target.closest("[data-action]");
  if (!element) return;
  const action = element.dataset.action;
  void handleAction(action, element.dataset.id, element);
});

let refreshPromise;

async function refreshSession() {
  state.sessionRefreshing = Boolean(state.user);
  if (state.sessionRefreshing) renderShell();
  try {
    const response = await fetch("/api/auth/status", { cache: "no-store" });
    if (response.status === 401) {
      resetStreams();
      state.user = null;
      state.guilds = [];
      state.selectedGuildId = null;
      state.selectedChannelId = null;
      renderLogin("Discord login expired. Sign in again.");
      return;
    }
    if (!response.ok) throw new Error("Server refresh failed");
    const data = await response.json();
    if (!data.authenticated) {
      resetStreams();
      state.user = null;
      state.guilds = [];
      state.selectedGuildId = null;
      state.selectedChannelId = null;
      const error = new URLSearchParams(window.location.search).get("auth_error");
      renderLogin(error === "private" ? "This instance is private." : error ? "Discord login failed. Try again." : "");
      return;
    }
    if (state.user?.id !== data.user.id) {
      resetStreams();
      state.selectedGuildId = null;
      state.selectedChannelId = null;
      state.channels = [];
      state.roles = [];
      state.mobileView = "servers";
    }
    const previousGuild = selectedGuild();
    state.user = data.user;
    state.guilds = data.guilds ?? [];
    state.demo = Boolean(data.demo);
    const guild = selectedGuild();
    if (previousGuild && !guild) {
      resetStreams();
      state.selectedGuildId = null;
      state.selectedChannelId = null;
      state.channels = [];
      state.roles = [];
      state.mobileView = "servers";
    } else if (guild && guild.botAdded !== previousGuild?.botAdded) {
      await selectGuild(guild.id);
    }
    const streamsPending = state.selectedChannelId ? loadStreams() : null;
    renderShell();
    await streamsPending;
    if (streamsPending && state.user) renderShell();
    if (new URLSearchParams(window.location.search).has("invite_error")) {
      showToast("Bot authorization was not completed. Try again.");
      window.history.replaceState(null, "", window.location.pathname);
    }
  } catch {
    if (state.user) showToast("Could not refresh your servers. Try again.");
    else renderLogin("Could not connect. Try again.");
  } finally {
    state.sessionRefreshing = false;
    if (state.user) renderShell();
  }
}

function start() {
  if (!refreshPromise) refreshPromise = refreshSession().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

window.addEventListener("focus", () => { void start(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void start();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void start();
});

renderLoading();
void start();
