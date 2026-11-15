import { Elysia } from "elysia";
import { authRoutes } from "./routes/auth";
import { guildRoutes } from "./routes/guilds";
import { staticRoutes } from "./routes/static";

export const app = new Elysia()
  .use(staticRoutes)
  .use(authRoutes)
  .use(guildRoutes);
