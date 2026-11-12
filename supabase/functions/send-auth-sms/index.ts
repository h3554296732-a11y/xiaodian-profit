// These pinned npm imports are resolved by the Deno Edge runtime, not Next.js.
// @ts-ignore -- Deno npm module specifier.
import { Webhook } from "npm:standardwebhooks@1.1.1";
// @ts-ignore -- Deno npm module specifier.
import { OpenApiUtil } from "npm:@alicloud/openapi-core@1.0.8";
import { createSmsHandler } from "./handler.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): unknown;
};

Deno.serve(
  createSmsHandler({
    readEnv: (name) => Deno.env.get(name),
    verifySignature(secret, payload, headers) {
      new Webhook(secret).verify(payload, headers, { jsonParse: false });
    },
    authorize: (
      request,
      algorithm,
      payloadHash,
      accessKeyId,
      accessKeySecret,
    ) =>
      OpenApiUtil.getAuthorization(
        request,
        algorithm,
        payloadHash,
        accessKeyId,
        accessKeySecret,
      ),
    fetch: (input, init) => fetch(input, init),
    onDiagnostic: (event) =>
      console.warn(JSON.stringify({ event: "auth_sms_failure", ...event })),
  }),
);
