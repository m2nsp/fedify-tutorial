// @ts-nocheck this file is just a template
import { serve } from "@hono/node-server";
import { behindProxy } from "x-forwarded-fetch";
import app from "./app.tsx";
import "./logging.ts";

serve(
  {
    port: 8000,
    hostname: "0.0.0.0",
    fetch: behindProxy(app.fetch.bind(app), {
      trustedProxies: () => true, //프록시 헤더를 신뢰하여 외부 터널 Host를 정상 수용하게 함
    }),
  },
  (info) => console.log("Server started at http://" + info.address + ":" + info.port),
);
