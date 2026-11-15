import { escapeHtml } from "./ui.js";

export const loadingSpinner = '<span class="loading-spinner" aria-hidden="true"></span>';

export function loadingStatus(label) {
  return `<span class="loading-status" role="status">${loadingSpinner}<span>${escapeHtml(label)}</span></span>`;
}

export function channelSkeleton() {
  return `<span class="visually-hidden" role="status">Loading channels</span><div class="channel-skeleton" aria-hidden="true">${[0, 1].map(() => `
    <div class="skeleton channel-skeleton-heading"></div>
    ${[68, 82, 56, 74].map((width) => `<div class="channel-skeleton-row"><span class="skeleton channel-skeleton-icon"></span><span class="skeleton channel-skeleton-line" style="width:${width}%"></span></div>`).join("")}
  `).join("")}</div>`;
}

export function streamSkeleton() {
  return `<div class="stream-loading" aria-busy="true">
    ${loadingStatus("Loading stream URLs...")}
    <div class="stream-list" aria-hidden="true">${[72, 58, 66].map((width) => `<div class="stream-row stream-skeleton-row">
      <span class="skeleton stream-skeleton-icon"></span><span class="stream-skeleton-copy"><span class="skeleton stream-skeleton-line" style="width:${width}%"></span><span class="skeleton stream-skeleton-date"></span></span>
      <span class="skeleton stream-skeleton-button"></span><span class="skeleton stream-skeleton-button"></span>
    </div>`).join("")}</div>
  </div>`;
}
