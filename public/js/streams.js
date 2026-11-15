import { state } from "./state.js";

let requestVersion = 0;

function context() {
  if (!state.user || !state.selectedGuildId || !state.selectedChannelId) return null;
  return JSON.stringify([state.user.id, state.selectedGuildId, state.selectedChannelId]);
}

function endpoint() {
  return `/api/guilds/${encodeURIComponent(state.selectedGuildId)}/channels/${encodeURIComponent(state.selectedChannelId)}/streams`;
}

function isCurrent(selected, version) {
  return context() === selected && requestVersion === version;
}

async function responseError(response, fallback) {
  try {
    return (await response.json()).error || fallback;
  } catch {
    return fallback;
  }
}

export function readStreams() {
  return state.streamsContext === context() ? state.streams : [];
}

export function resetStreams() {
  requestVersion += 1;
  state.streamsContext = null;
  state.streams = [];
  state.streamsLoading = false;
  state.streamsError = "";
  state.streamsMutating = false;
  state.deletingStreamKey = null;
}

export async function loadStreams() {
  const selected = context();
  if (!selected || state.streamsMutating) return;
  const version = ++requestVersion;
  if (state.streamsContext !== selected) state.streams = [];
  state.streamsContext = selected;
  state.streamsLoading = true;
  state.streamsError = "";
  try {
    const response = await fetch(endpoint(), { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response, "Could not load stream URLs."));
    const data = await response.json();
    if (isCurrent(selected, version)) state.streams = Array.isArray(data.streams) ? data.streams : [];
  } catch (error) {
    if (isCurrent(selected, version)) state.streamsError = error.message;
  } finally {
    if (isCurrent(selected, version)) state.streamsLoading = false;
  }
}

export async function createStream() {
  const selected = context();
  if (!selected || state.streamsLoading || state.streamsMutating || state.streamsError) return;
  const version = ++requestVersion;
  state.streamsMutating = true;
  try {
    const response = await fetch(endpoint(), { method: "POST" });
    if (!response.ok) throw new Error(await responseError(response, "Could not create a stream URL."));
    const { stream } = await response.json();
    if (!isCurrent(selected, version)) return;
    state.streams.push(stream);
    return "Stream URL created";
  } catch (error) {
    if (isCurrent(selected, version)) return error.message;
  } finally {
    if (isCurrent(selected, version)) state.streamsMutating = false;
  }
}

export async function deleteStream(key) {
  const selected = context();
  if (!selected || state.streamsLoading || state.streamsMutating || !readStreams().some((stream) => stream.key === key)) return;
  const version = ++requestVersion;
  state.streamsMutating = true;
  state.deletingStreamKey = key;
  try {
    const response = await fetch(`${endpoint()}/${encodeURIComponent(key)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await responseError(response, "Could not delete this stream URL."));
    if (!isCurrent(selected, version)) return;
    state.streams = state.streams.filter((stream) => stream.key !== key);
    return "Stream URL deleted";
  } catch (error) {
    if (isCurrent(selected, version)) return error.message;
  } finally {
    if (isCurrent(selected, version)) {
      state.streamsMutating = false;
      state.deletingStreamKey = null;
    }
  }
}
