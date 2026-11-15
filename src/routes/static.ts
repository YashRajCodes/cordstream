import { Elysia } from "elysia";

export const staticRoutes = new Elysia({ name: "static" })
  .get("/", () => Bun.file("public/index.html"))
  .get("/styles.css", () => Bun.file("public/styles.css"))
  .get("/app.js", () => Bun.file("public/app.js"))
  .get("/fonts/:name", ({ params, set }) => {
    if (!/^(?:outfit|google-sans-code)-\d+\.ttf$/.test(params.name)) {
      set.status = 404;
      return "Not found";
    }
    return Bun.file(`public/fonts/${params.name}`);
  })
  .get("/js/*", ({ params, set }) => {
    if (!/^(?:views\/)?[a-z-]+\.js$/.test(params["*"])) {
      set.status = 404;
      return "Not found";
    }
    return Bun.file(`public/js/${params["*"]}`);
  })
  .get("/styles/:name", ({ params, set }) => {
    if (!/^[a-z-]+\.css$/.test(params.name)) {
      set.status = 404;
      return "Not found";
    }
    return Bun.file(`public/styles/${params.name}`);
  });
