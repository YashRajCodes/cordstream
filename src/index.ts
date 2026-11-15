import { app } from "./app";
import { port } from "./config";

app.listen({ port, idleTimeout: 60 });

console.log(`cordstream is running at ${app.server?.hostname}:${app.server?.port}`);
