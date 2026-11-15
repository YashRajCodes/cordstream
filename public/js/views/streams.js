import { selectedChannel, selectedGuild, state } from "../state.js";
import { readStreams } from "../streams.js";
import { escapeHtml, icons } from "../ui.js";

function createdLabel(timestamp) {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "Created just now";
  if (minutes < 60) return `Created ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Created ${hours}h ago`;
  return `Created ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp)}`;
}

function renderStreamRows() {
  const links = readStreams();
  if (!links.length) return `<div class="stream-empty">No stream URLs yet.</div>`;
  return `<div class="stream-list">${links.slice().reverse().map((link) => {
    const url = escapeHtml(link.url);
    return `<article class="stream-row">
      <span class="stream-link-wrap">
        <span class="stream-link-mark">${icons.link}</span>
        <span class="stream-copy"><a class="stream-url" href="${url}" data-action="stream-link" data-url="${url}" title="${url}">${url}</a><span class="stream-created">${escapeHtml(createdLabel(link.createdAt))}</span></span>
      </span>
      <button class="copy-button" type="button" data-action="copy-stream" data-url="${url}" title="Copy stream URL" aria-label="Copy stream URL">${icons.copy}</button>
    </article>`;
  }).join("")}</div>`;
}

export function renderMainPanel() {
  const guild = selectedGuild();
  const channel = selectedChannel();
  if (!guild) return `<section class="stream-panel"><div class="empty-state empty-state-server"><p class="empty-title">Choose a server</p></div></section>`;
  if (!guild.botAdded) {
    return `<section class="stream-panel"><div class="empty-state"><div class="bot-state">
      <p>Add cordstream to <strong>${escapeHtml(guild.name)}</strong> to view its channels.</p>
      <button class="invite-button" type="button" data-action="invite">Add bot</button>
    </div></div></section>`;
  }
  if (!channel) {
    const text = state.channelsLoading ? "Loading channels" : state.channelsError ? "Couldn't load channels" : "Select a channel";
    return `<section class="stream-panel"><div class="empty-state"><p>${text}</p></div></section>`;
  }

  return `<section class="stream-panel">
    <div class="content-body">
      <button class="create-button create-button-wide" type="button" data-action="create-stream">${icons.plus}<span>Create stream URL</span></button>
      <div class="section-head"><h2>Stream URLs</h2><span class="stream-count">${readStreams().length}</span></div>
      ${renderStreamRows()}
    </div>
  </section>`;
}
