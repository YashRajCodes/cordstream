# cordstream

cordstream is a Discord server and channel picker for creating stream URLs.

Run the app locally with Bun:

```sh
bun run dev
```

Open http://localhost:3001. Without Discord credentials, development mode opens a demo session. Stream URLs are stored in browser local storage and are not active streams yet.

To enable Discord OAuth, copy `.env.example` to `.env` and set `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `DISCORD_BOT_TOKEN`. Add the exact value of `DISCORD_REDIRECT_URI` to the Discord application's OAuth2 redirect URLs. cordstream requests the `identify`, `guilds`, and `guilds.members.read` scopes. The server list only includes guilds where the user owns the server or has the Administrator permission. The bot needs the View Channels permission to list server channels and roles.

The app refreshes your servers and bot membership when you open it or return to its tab. Bot invites preselect the chosen server and return to the app through the same `DISCORD_REDIRECT_URI` after authorization.

The OAuth session is held in memory and expires after seven days. Restarting the server signs users out.
