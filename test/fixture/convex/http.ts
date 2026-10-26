import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();
http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => new Response("ok")),
});
export default http;
