export const state = {
  user: null,
  guilds: [],
  demo: false,
  sessionRefreshing: false,
  selectedGuildId: null,
  selectedChannelId: null,
  channels: [],
  roles: [],
  channelsLoading: false,
  channelsError: false,
  streamsContext: null,
  streams: [],
  streamsLoading: false,
  streamsError: "",
  streamsMutating: false,
  deletingStreamKey: null,
  openCategories: new Set(),
  mobileView: "servers",
};

export function selectedGuild() {
  return state.guilds.find((guild) => guild.id === state.selectedGuildId) ?? null;
}

export function selectedChannel() {
  return state.channels.find((channel) => channel.id === state.selectedChannelId) ?? null;
}

export function sortedGuilds() {
  return [...state.guilds].sort((a, b) => Number(b.botAdded) - Number(a.botAdded) || a.name.localeCompare(b.name));
}
