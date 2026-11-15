import { Elysia } from "elysia";
import { authRoutes } from "./routes/auth";
import { guildRoutes } from "./routes/guilds";
import { staticRoutes } from "./routes/static";
import { streamManagementRoutes } from "./routes/streams";
import { streamRoutes } from "./routes/stream";
import { discordGateway } from "./gateway";
import { streamStore } from "./stream-store";

export const app = new Elysia()
  .use(staticRoutes)
  .use(authRoutes)
  .use(guildRoutes)
  .use(streamManagementRoutes)
  .use(streamRoutes)
  .onStop(() => {
    discordGateway.stop();
    streamStore.close();
  });
