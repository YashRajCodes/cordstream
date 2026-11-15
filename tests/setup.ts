// Set these before any test imports app configuration, regardless of discovery order.
for (const key of ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_BOT_TOKEN"]) {
  Bun.env[key] = `test-${key}`;
}
Bun.env.STREAM_DATABASE_PATH = ":memory:";
