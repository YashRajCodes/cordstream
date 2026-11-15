import { Elysia } from "elysia";
import { streamStore } from "../stream-store";
import { createStreamResponse, publicStreamHeaders } from "../streaming";

function streamError(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: publicStreamHeaders });
}

export const streamRoutes = new Elysia({ name: "public-stream" })
  .get("/stream/:guildId/:channelId", ({ params, request }) => {
    const keys = new URL(request.url).searchParams.getAll("key");
    if (keys.length !== 1 || !keys[0] || keys[0].length > 256) return streamError("Supply one public stream key.", 400);
    const stream = streamStore.find(keys[0], params.guildId, params.channelId);
    if (!stream) return streamError("Stream URL not found.", 404);
    return createStreamResponse(request, stream);
  })
  .options("/stream/:guildId/:channelId", () => new Response(null, {
    status: 204,
    headers: {
      ...publicStreamHeaders,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Last-Event-ID",
    },
  }));
