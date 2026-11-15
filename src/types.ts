export type Role = {
  id: string;
  name: string;
  color: number;
  permissions: string;
  permissionNames: string[];
};

export type Guild = {
  id: string;
  name: string;
  icon: string | null;
  botAdded: boolean;
};

export type DiscordGuild = Omit<Guild, "botAdded"> & { owner?: boolean; permissions?: string };

export type DiscordApplication = {
  id: string;
  owner?: { id: string };
  team?: {
    owner_user_id?: string;
    members?: Array<{
      membership_state?: number;
      user?: { id: string };
    }>;
  } | null;
};

export type Session = {
  user: { id: string; username: string; global_name?: string | null; avatar?: string | null };
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;
  demo?: boolean;
  guilds?: DiscordGuild[];
  guildsCheckedAt?: number;
  botStatus?: Map<string, boolean>;
  botStatusCheckedAt?: number;
  botInvite?: { state: string; issuedAt: number };
  expiresAt: number;
};

export type DiscordChannel = {
  id: string;
  name: string;
  type: number;
  position: number;
  parent_id?: string | null;
};
