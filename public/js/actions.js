import { renderLogin, renderShell } from "./render.js";
import { selectedGuild, state } from "./state.js";
import { readStreams, writeStreams } from "./streams.js";
import { copyUrl, showToast } from "./ui.js";

export async function selectGuild(id) {
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
    if (state.selectedGuildId !== id) return;
    state.channels = data.channels ?? [];
    state.roles = data.roles ?? [];
    for (const category of state.channels.filter((channel) => channel.type === 4)) state.openCategories.add(category.id);
  } catch {
    if (state.selectedGuildId !== id) return;
    state.channelsError = true;
  }
  state.channelsLoading = false;
  renderShell();
}

function makeStreamUrl() {
  const token = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const links = readStreams();
  links.push({ id: token, url: `${window.location.origin}/s/${token}`, createdAt: Date.now() });
  writeStreams(links);
  renderShell();
  showToast("Stream URL created");
}

export async function handleAction(action, id, element) {
  if (action === "select-guild") return selectGuild(id);
  if (action === "select-channel") {
    state.selectedChannelId = id;
    state.mobileView = "stream";
    renderShell();
    return;
  }
  if (action === "toggle-category") {
    state.openCategories.has(id) ? state.openCategories.delete(id) : state.openCategories.add(id);
    renderShell();
    return;
  }
  if (action === "create-stream") return makeStreamUrl();
  if (action === "copy-stream") return copyUrl(element.dataset.url);
  if (action === "stream-link") {
    showToast("Stream playback is not connected yet");
    return;
  }
  if (action === "logout") {
    await fetch("/api/auth/logout", { method: "POST" });
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
