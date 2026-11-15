import { app } from "./app";
import { port } from "./config";

app.listen(port);

console.log(`cordstream is running at ${app.server?.hostname}:${app.server?.port}`);
