import { selectedGuild, sortedGuilds, state } from "../state.js";
import { escapeHtml, icons, shortName } from "../ui.js";

function guildIcon(guild) {
  if (guild.icon) {
    const src = `https://cdn.discordapp.com/icons/${encodeURIComponent(guild.id)}/${encodeURIComponent(guild.icon)}.png?size=96`;
    return `<img src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  }
  return escapeHtml(shortName(guild.name));
}

function userAvatar() {
  if (!state.user?.avatar) return `<span class="user-avatar user-avatar-fallback">${escapeHtml(shortName(state.user?.global_name || state.user?.username))}</span>`;
  const extension = state.user.avatar.startsWith("a_") ? "gif" : "png";
  const src = `https://cdn.discordapp.com/avatars/${encodeURIComponent(state.user.id)}/${encodeURIComponent(state.user.avatar)}.${extension}?size=64`;
  return `<img class="user-avatar" src="${escapeHtml(src)}" alt="" referrerpolicy="no-referrer">`;
}

export function renderServerRail() {
  return `<nav class="server-rail" aria-label="Discord servers"><div class="server-list">
    ${sortedGuilds().map((guild) => `<button class="server-button" type="button" data-action="select-guild" data-id="${escapeHtml(guild.id)}" data-bot="${guild.botAdded}" aria-current="${guild.id === state.selectedGuildId}" title="${escapeHtml(guild.name)}">
      <span class="server-icon-wrap"><span class="server-icon">${guildIcon(guild)}</span></span>
      <span class="server-name">${escapeHtml(guild.name)}</span>
    </button>`).join("")}
  </div><div class="server-rail-footer"><details class="user-menu">
    <summary class="user-menu-trigger" aria-label="Open account menu" title="Open account menu">${userAvatar()}</summary>
    <div class="user-menu-popover"><button class="user-menu-logout" type="button" data-action="logout">${icons.logout}<span>Log out</span></button></div>
  </details></div></nav>`;
}

function sortedChannels(channels) {
  return [...channels].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

function channelButton(channel) {
  const voice = [2, 13].includes(channel.type);
  const symbol = voice
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 512 512" fill="none" stroke="currentColor" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32" d="M192 448h128m64-240v32c0 70.4-57.6 128-128 128h0c-70.4 0-128-57.6-128-128v-32m128 160v80"></path><path fill="currentColor" d="M256 320a78.83 78.83 0 0 1-56.55-24.1A80.9 80.9 0 0 1 176 239V128a79.69 79.69 0 0 1 80-80c44.86 0 80 35.14 80 80v111c0 44.66-35.89 81-80 81"></path></svg>'
    : "#";
  const active = channel.id === state.selectedChannelId;
  return `<button class="channel-button" type="button" data-action="select-channel" data-id="${escapeHtml(channel.id)}" aria-current="${active}">
    <span class="channel-symbol">${symbol}</span><span class="channel-label">${escapeHtml(channel.name)}</span>
  </button>`;
}

function renderChannelContents() {
  if (state.channelsLoading) return `<div class="empty-state"><p>Loading channels</p></div>`;
  if (state.channelsError) return `<div class="empty-state"><p>Couldn't load channels</p></div>`;
  if (!state.channels.length) return `<div class="empty-state"><p>No channels</p></div>`;

  const categories = sortedChannels(state.channels.filter((channel) => channel.type === 4));
  const otherChannels = state.channels.filter((channel) => channel.type !== 4);
  const groupedIds = new Set();
  const categoryMarkup = categories.map((category) => {
    const channels = sortedChannels(otherChannels.filter((channel) => channel.parent_id === category.id));
    channels.forEach((channel) => groupedIds.add(channel.id));
    if (!channels.length) return "";
    const isOpen = state.openCategories.has(category.id);
    return `<section class="channel-category">
      <button class="category-toggle" type="button" data-action="toggle-category" data-id="${escapeHtml(category.id)}" aria-expanded="${isOpen}"><span class="category-caret">${isOpen ? icons.caretDown : icons.caretRight}</span><span>${escapeHtml(category.name)}</span></button>
      ${isOpen ? channels.map(channelButton).join("") : ""}
    </section>`;
  }).join("");
  const uncategorized = sortedChannels(otherChannels.filter((channel) => !groupedIds.has(channel.id)));
  const uncategorizedMarkup = uncategorized.length
    ? `<section class="channel-category">${uncategorized.map(channelButton).join("")}</section>`
    : "";
  return `${categoryMarkup}${uncategorizedMarkup}`;
}

export function renderChannelsPanel() {
  const guild = selectedGuild();
  if (!guild?.botAdded) return "";
  return `<aside class="channels-panel">
    <div class="channels-scroll">${guild.botAdded ? renderChannelContents() : ""}</div>
  </aside>`;
}
