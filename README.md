# cordstream

cordstream creates public Server-Sent Events streams for Discord channels. Each connection starts with the latest 50 messages, then receives live message, edit, deletion, and reaction events.

## Setup

Install [Bun](https://bun.sh), then run:

```sh
bun install
cp .env.example .env
bun run dev
```

Open http://localhost:3001. Without Discord credentials, development mode provides a demo session. Demo streams send a snapshot with `demo: true` and two synthetic messages; they do not receive live Discord events.

Set these environment variables for Discord:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port, default `3001`. |
| `APP_URL` | Public origin used in generated stream URLs, default `http://localhost:3001`. Set this to your site's URL when deployed. |
| `DISCORD_REDIRECT_URI` | OAuth callback URL. It must exactly match a redirect URL in the Discord Developer Portal. Defaults to `${APP_URL}/api/auth/callback`. |
| `DISCORD_CLIENT_ID` | Discord application ID. |
| `DISCORD_CLIENT_SECRET` | Discord OAuth client secret. |
| `DISCORD_BOT_TOKEN` | Bot token used for message history and Gateway events. |
| `STREAM_DATABASE_PATH` | SQLite file for stream links, default `./data/cordstream.sqlite`. Keep this file across deployments. |

In the Discord Developer Portal, enable the bot's **Message Content Intent**. Discord must approve this intent for applications that require approval. cordstream requests the `GUILDS`, `GUILD_MESSAGES`, `GUILD_MESSAGE_REACTIONS`, and `MESSAGE_CONTENT` Gateway intents. Without message content access, Discord can omit content, embeds, attachments, and components.

Invite the bot to the selected server and give it **View Channel** and **Read Message History** in the channel you want to stream. The invite requests permission value `66560`. Existing bot installations may need their channel permissions updated. Private channels and threads also require the bot to have access.

The picker lists text, announcement, voice, and stage channels. Voice and stage streams carry text chat events. The management API also accepts individual thread IDs when the bot can read that thread. Threads are not currently listed in the picker. A forum or media channel's posts are threads, so use the individual thread ID rather than the parent channel ID.

OAuth requests the `identify`, `guilds`, and `guilds.members.read` scopes. The server picker only shows servers where the signed-in user owns the server or has Administrator permission. The app refreshes servers and bot membership when opened or when you return to its tab. Bot invites preselect the server and return through `DISCORD_REDIRECT_URI`.

Every channel load, bot invite, and stream list, create, or delete request checks the user's server permissions. Permission data and bot membership checks stay in memory for at most one minute. An action refreshes expired permissions through Discord before proceeding, and a failed refresh blocks the action. Opening or returning to the app forces an earlier refresh. The public SSE links remain readable without a user session.

OAuth sessions expire after seven days and live in memory. Restarting cordstream signs users out. Stream links live in SQLite and survive restarts.

SQLite only stores stream keys, their server/channel and creator IDs, and creation metadata. Messages and live event buffers stay in the running app. There is no Redis or persistent message cache.

## Docker

Copy `.env.example` to `.env` and set your Discord credentials, `APP_URL`, and `DISCORD_REDIRECT_URI`. The container runs in production mode, which requires Discord credentials and HTTPS for login cookies.

```sh
docker compose up -d --build
```

The default publishes `PORT` on all host interfaces. Set `BIND_ADDRESS=127.0.0.1` in `.env` for a reverse proxy running on the host. For a reverse proxy on the same Docker network, use Docker Compose 2.24.0 or newer:

```sh
docker compose -f compose.yaml -f compose.internal.yaml up -d --build
```

This publishes no host port. Attach your reverse proxy to the project's default network and forward requests to `cordstream:3001`, or the `PORT` you configured. Keep response buffering disabled for `/stream/`.

For production with the published GHCR image and a reverse proxy running on the host, use `compose.production.yaml`. It binds the app to `127.0.0.1` and keeps SQLite data in the `cordstream-data` volume:

```sh
docker compose -f compose.production.yaml pull
docker compose -f compose.production.yaml up -d
```

If your reverse proxy runs in Docker, add `compose.internal.yaml` to both commands. That removes the host port and exposes the app on the Compose network:

```sh
docker compose -f compose.production.yaml -f compose.internal.yaml pull
docker compose -f compose.production.yaml -f compose.internal.yaml up -d
```

All Compose configurations use `restart: always` and keep stream links in the `cordstream-data` volume at `/app/data/cordstream.sqlite`. Compose sets this path regardless of `STREAM_DATABASE_PATH` in `.env`.

The Docker image workflow publishes AMD64 and ARM64 images to `ghcr.io/yashrajcodes/cordstream` on pushes to `main` or `master`, `v*` tags, and manual runs. The `latest` tag follows the default branch. Pull requests build without publishing.

To use a published image, set `CORDSTREAM_IMAGE=ghcr.io/yashrajcodes/cordstream:latest` in `.env`, then run:

```sh
docker compose pull
docker compose up -d --no-build
```

Include `-f compose.yaml -f compose.internal.yaml` in both commands for the internal network mode.

## Stream links

Select a channel and click **Create stream URL**. The Stream URLs section lists links in this form:

```text
https://site.com/stream/SERVER_ID/CHANNEL_ID?key=PUBLIC_KEY
```

The key is intentionally public. You can put the complete URL in another site's JavaScript. Anyone with the URL can read that channel's stream without logging in, and the SSE endpoint allows cross-origin access with `Access-Control-Allow-Origin: *`.

Use the copy button to copy a URL. The delete button revokes that link and closes its active connections. Other links for the channel keep working.

Signed-in server administrators manage their own links through these endpoints. Requests use the app's session cookie.

| Method | Endpoint | Response |
| --- | --- | --- |
| `GET` | `/api/guilds/:guildId/channels/:channelId/streams` | `{ "streams": [stream] }` |
| `POST` | `/api/guilds/:guildId/channels/:channelId/streams` | `{ "stream": stream }` |
| `DELETE` | `/api/guilds/:guildId/channels/:channelId/streams/:key` | `204 No Content` |

A stream record contains `key`, `url`, `createdAt`, `guildId`, and `channelId`. `createdAt` is a Unix timestamp in milliseconds. The public key only works for the server and channel in its URL. Management endpoints require an authenticated owner or administrator of that server, and links belong to the user who created them.

## SSE events

Connect to the generated URL with `EventSource`. The response uses `text/event-stream`, disables caching, and sends heartbeat comments about every 15 seconds. Heartbeats do not produce JavaScript events.

| Event | JSON data | Client action |
| --- | --- | --- |
| `snapshot` | `{ "guild_id": "...", "channel_id": "...", "messages": [...] }` | Replace local history with up to 50 messages, ordered oldest first. |
| `MESSAGE_CREATE` | Discord message object. | Add or replace the message by `id`. |
| `MESSAGE_UPDATE` | Discord's partial message object. | Merge fields into the existing message with that `id`. Missing fields have not changed. |
| `MESSAGE_DELETE` | `{ "id": "...", "channel_id": "...", "guild_id": "..." }` | Remove the message by `id`. |
| `MESSAGE_DELETE_BULK` | `{ "ids": ["..."], "channel_id": "...", "guild_id": "..." }` | Remove every message in `ids`. |
| `MESSAGE_REACTION_ADD` | Discord reaction-add payload. | Update the reaction on `message_id`. |
| `MESSAGE_REACTION_REMOVE` | Discord reaction-remove payload. | Update the reaction on `message_id`. |
| `MESSAGE_REACTION_REMOVE_ALL` | Discord remove-all-reactions payload. | Clear reactions on `message_id`. |
| `MESSAGE_REACTION_REMOVE_EMOJI` | Discord remove-emoji-reaction payload. | Remove that emoji's reactions on `message_id`. |
| `CHANNEL_UPDATE`, `CHANNEL_DELETE` | Discord channel object. | Update channel metadata or handle deletion. |
| `THREAD_UPDATE`, `THREAD_DELETE` | Discord thread object. | Update thread metadata or handle deletion. |
| `stream_deleted` | `{ "guild_id": "...", "channel_id": "..." }` | Close `EventSource`; the link was revoked. |
| `stream_error` | `{ "code": "...", "message": "..." }` | Report the upstream failure. |

`stream_error` closes the connection after delivery. Its `code` is `history_error`, `gateway_error`, `gateway_reset`, `buffer_overflow`, or `slow_consumer`. `EventSource` retries automatically unless your client closes it. Missing keys return HTTP `400`; invalid, deleted, or mismatched keys return HTTP `404`. These error responses contain JSON and allow cross-origin access.

Message history and live events preserve Discord's raw JSON fields. This includes `author.username`, `author.global_name`, avatars, `member.nick` when supplied, content, timestamps, attachments, embeds, embed fields, image and thumbnail URLs, `proxy_url` values, mentions, references, components, polls, and other fields Discord sends. Availability depends on the event, bot permissions, and Discord API behavior. cordstream does not fill missing fields or convert partial edits into complete messages. Discord IDs remain strings.

For a display name, use `message.member?.nick ?? message.author?.global_name ?? message.author?.username`. An edit may arrive for a message outside your loaded history. Ignore that edit or fetch the message separately in your own application. Message deletions can also reference messages outside the snapshot.

The server subscribes to live events before it fetches history and buffers updates until after `snapshot`. A create event can overlap a message already in the snapshot, so deduplicate by message ID.

`EventSource` reconnects after a dropped connection. Each new connection receives a fresh snapshot; replace the old history rather than appending it. Discord Gateway sessions resume when possible. If a Gateway session cannot resume, cordstream closes the SSE connection so the client reconnects and gets current history. There is no durable event replay or `Last-Event-ID` cursor, so a long outage can miss messages beyond the latest 50.

## Browser example

This example shows the latest 50 messages as text. Add `<div id="chat"></div>` to your page and replace the URL with one from Stream URLs.

```js
const chat = document.querySelector("#chat");
const messages = new Map();
const source = new EventSource(
  "https://site.com/stream/SERVER_ID/CHANNEL_ID?key=PUBLIC_KEY"
);

function render() {
  const rows = [...messages.values()].map((message) => {
    const row = document.createElement("p");
    const name = message.member?.nick
      ?? message.author?.global_name
      ?? message.author?.username
      ?? "Unknown user";
    row.textContent = `${name}: ${message.content ?? ""}`;
    return row;
  });
  chat.replaceChildren(...rows);
}

source.addEventListener("snapshot", (event) => {
  messages.clear();
  for (const message of JSON.parse(event.data).messages) {
    messages.set(message.id, message);
  }
  render();
});

source.addEventListener("MESSAGE_CREATE", (event) => {
  const message = JSON.parse(event.data);
  messages.set(message.id, message);
  while (messages.size > 50) messages.delete(messages.keys().next().value);
  render();
});

source.addEventListener("MESSAGE_UPDATE", (event) => {
  const patch = JSON.parse(event.data);
  const previous = messages.get(patch.id);
  if (previous) messages.set(patch.id, { ...previous, ...patch });
  render();
});

source.addEventListener("MESSAGE_DELETE", (event) => {
  messages.delete(JSON.parse(event.data).id);
  render();
});

source.addEventListener("MESSAGE_DELETE_BULK", (event) => {
  for (const id of JSON.parse(event.data).ids) messages.delete(id);
  render();
});

source.addEventListener("stream_deleted", () => {
  source.close();
  chat.textContent = "This stream link was deleted.";
});

source.addEventListener("stream_error", (event) => {
  console.error(JSON.parse(event.data));
});

source.onerror = () => {
  // EventSource retries automatically unless you call source.close().
};
```

Build embed and attachment previews from the same raw objects, such as `message.embeds`, `embed.fields`, `embed.image.proxy_url`, and `message.attachments`. Treat Discord content as untrusted text. Use `textContent` for plain text, or escape and sanitize rendered Markdown before inserting HTML.

When deploying behind a reverse proxy, disable response buffering for `/stream/` and allow long HTTP connections. The SSE response also sets `X-Accel-Buffering: no` for Nginx. Run one cordstream process for shared live subscriptions and immediate link revocation.

Run the test suite with `bun test`.
