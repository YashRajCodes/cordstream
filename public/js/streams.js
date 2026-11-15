import { state } from "./state.js";
import { showToast } from "./ui.js";

function streamKey() {
  return `cordstream:streams:${state.user?.id ?? "anonymous"}`;
}

export function readStreams() {
  try {
    const saved = JSON.parse(localStorage.getItem(streamKey()) || "{}");
    return Array.isArray(saved[state.selectedGuildId]?.[state.selectedChannelId])
      ? saved[state.selectedGuildId][state.selectedChannelId]
      : [];
  } catch {
    return [];
  }
}

export function writeStreams(links) {
  try {
    const saved = JSON.parse(localStorage.getItem(streamKey()) || "{}");
    saved[state.selectedGuildId] ??= {};
    saved[state.selectedGuildId][state.selectedChannelId] = links;
    localStorage.setItem(streamKey(), JSON.stringify(saved));
  } catch {
    showToast("Could not save this URL in the browser.");
  }
}
