import { selectedChannel, selectedGuild, state } from "../state.js";
import { readStreams } from "../streams.js";
import { escapeHtml, icons } from "../ui.js";
import { loadingSpinner, loadingStatus, streamSkeleton } from "../loading.js";

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
  if (state.streamsLoading && !links.length && !state.streamsError) return streamSkeleton();
  const feedback = state.streamsError
    ? `<div class="stream-empty" role="status">${escapeHtml(state.streamsError)} <button class="stream-retry" type="button" data-action="retry-streams">Retry</button></div>`
    : "";
  if (!links.length) return feedback || `<div class="stream-empty">No stream URLs yet.</div>`;
  const disabled = state.streamsLoading || state.streamsMutating ? " disabled" : "";
  return `${feedback}<div class="stream-list">${links.slice().reverse().map((link) => {
    const url = escapeHtml(link.url);
    const deleting = state.deletingStreamKey === link.key;
    return `<article class="stream-row">
      <span class="stream-link-wrap">
        <span class="stream-link-mark">${icons.link}</span>
        <span class="stream-copy"><a class="stream-url" href="${url}" target="_blank" rel="noopener noreferrer" title="${url}">${url}</a><span class="stream-created">${escapeHtml(createdLabel(link.createdAt))}</span></span>
      </span>
      <button class="copy-button" type="button" data-action="copy-stream" data-url="${url}" title="Copy stream URL" aria-label="Copy stream URL">${icons.copy}</button>
      <button class="copy-button delete-button" type="button" data-action="delete-stream" data-id="${escapeHtml(link.key)}" title="${deleting ? "Deleting" : "Delete"} stream URL" aria-label="${deleting ? "Deleting" : "Delete"} stream URL" aria-busy="${deleting}"${disabled}>${deleting ? loadingSpinner : icons.trash}</button>
      ${deleting ? '<span class="visually-hidden" role="status">Deleting stream URL...</span>' : ""}
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
    if (state.channelsLoading) return `<section class="stream-panel" aria-busy="true"><div class="empty-state">${loadingStatus("Loading channels")}</div></section>`;
    const text = state.channelsError ? "Couldn't load channels" : "Select a channel";
    return `<section class="stream-panel"><div class="empty-state"><p>${text}</p></div></section>`;
  }

  const creating = state.streamsMutating && !state.deletingStreamKey;
  return `<section class="stream-panel" aria-busy="${state.streamsLoading || state.streamsMutating}">
    <div class="content-body">
      <button class="create-button create-button-wide" type="button" data-action="create-stream" aria-busy="${creating}"${state.streamsLoading || state.streamsMutating || state.streamsError ? " disabled" : ""}>${creating ? loadingSpinner : icons.plus}<span>${creating ? "Creating stream URL..." : "Create stream URL"}</span></button>
      <div class="section-head"><h2>Stream URLs</h2>${state.streamsLoading && readStreams().length ? `<span class="stream-count">${loadingStatus("Refreshing stream URLs")}</span>` : `<span class="stream-count">${readStreams().length}</span>`}</div>
      ${renderStreamRows()}
    </div>
  </section>`;
}
