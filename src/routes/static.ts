import { Elysia } from "elysia";

const brandAssets = new Set([
  "cordstream-lockup.svg",
  "cordstream-lockup.png",
  "cordstream-lockup-on-black.png",
  "cordstream-icon.svg",
  "cordstream-icon.png",
]);

export const staticRoutes = new Elysia({ name: "static" })
  .get("/", () => Bun.file("public/index.html"))
  .get("/favicon.svg", () => Bun.file("public/favicon.svg"))
  .get("/favicon.ico", () => Bun.file("public/favicon.ico"))
  .get("/apple-touch-icon.png", () => Bun.file("public/apple-touch-icon.png"))
  .get("/brand/:name", ({ params, set }) => {
    if (!brandAssets.has(params.name)) {
      set.status = 404;
      return "Not found";
    }
    return Bun.file(`public/brand/${params.name}`);
  })
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
