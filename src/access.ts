import { demoGuilds } from "./demo";
import { refreshGuildPermissions } from "./discord";
import { apiError } from "./http";
import { hasAdministratorPermission } from "./permissions";
import { getSession } from "./session";

/** Every management action checks current guild access. Expired permission data never grants access. */
export async function requireGuildAccess(cookie: string | undefined, guildId: string) {
  const session = getSession(cookie);
  if (!session) return apiError("Not signed in.", 401);
  if (session.demo) {
    return demoGuilds.some((guild) => guild.id === guildId) ? session : apiError("Server not found.", 404);
  }
  try {
    const guilds = await refreshGuildPermissions(session);
    if (!guilds) return apiError("Discord login expired. Sign in again.", 401);
    return guilds.some((guild) => guild.id === guildId && hasAdministratorPermission(guild))
      ? session
      : apiError("Server not found.", 404);
  } catch {
    return apiError("Could not verify your server permissions. Try again.", 502);
  }
}
