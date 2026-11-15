import { renderLogin, renderShell } from "./render.js";
import { selectedGuild, state } from "./state.js";
import { createStream, deleteStream, loadStreams, resetStreams } from "./streams.js";
import { copyUrl, showToast } from "./ui.js";

let channelRequestVersion = 0;

export async function selectGuild(id) {
  const version = ++channelRequestVersion;
  const userId = state.user?.id;
  const isCurrent = () => version === channelRequestVersion && state.selectedGuildId === id && state.user?.id === userId;
  resetStreams();
  state.selectedGuildId = id;
  state.selectedChannelId = null;
  state.channels = [];
  state.roles = [];
  state.channelsLoading = true;
  state.channelsError = false;
  state.openCategories = new Set();
  const guild = selectedGuild();
  state.mobileView = guild?.botAdded ? "channels" : "stream";
  renderShell();
  if (!guild?.botAdded) {
    state.channelsLoading = false;
    renderShell();
    return;
  }
  try {
    const response = await fetch(`/api/guilds/${encodeURIComponent(id)}/channels`);
    if (!response.ok) throw new Error("Channel request failed");
    const data = await response.json();
    if (!isCurrent()) return;
    state.channels = data.channels ?? [];
    state.roles = data.roles ?? [];
    for (const category of state.channels.filter((channel) => channel.type === 4)) state.openCategories.add(category.id);
  } catch {
    if (!isCurrent()) return;
    state.channelsError = true;
  }
  state.channelsLoading = false;
  renderShell();
}

async function updateStreams(operation) {
  const pending = operation();
  renderShell();
  const message = await pending;
  if (!state.user) return;
  renderShell();
  if (message) showToast(message);
}

export async function handleAction(action, id, element) {
  if (action === "select-guild") return selectGuild(id);
  if (action === "select-channel") {
    resetStreams();
    state.selectedChannelId = id;
    state.mobileView = "stream";
    const pending = loadStreams();
    renderShell();
    await pending;
    if (state.user && state.selectedChannelId === id) renderShell();
    return;
  }
  if (action === "toggle-category") {
    state.openCategories.has(id) ? state.openCategories.delete(id) : state.openCategories.add(id);
    renderShell();
    return;
  }
  if (action === "create-stream") return updateStreams(createStream);
  if (action === "delete-stream") return updateStreams(() => deleteStream(id));
  if (action === "retry-streams") return updateStreams(loadStreams);
  if (action === "copy-stream") return copyUrl(element.dataset.url);
  if (action === "logout") {
    await fetch("/api/auth/logout", { method: "POST" });
    resetStreams();
    state.user = null;
    state.guilds = [];
    state.selectedGuildId = null;
    state.selectedChannelId = null;
    renderLogin();
    return;
  }
  if (action === "invite") {
    const guild = selectedGuild();
    if (!guild) return;
    try {
      const response = await fetch(`/api/guilds/${encodeURIComponent(guild.id)}/invite`);
      const result = await response.json();
      if (result.url) window.location.assign(result.url);
      else showToast("Set up Discord app credentials to add the bot");
    } catch {
      showToast("Could not open the bot invite");
    }
    return;
  }
}
