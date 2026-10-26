import { Effect, Option, Redacted, Schema, SchemaIssue, pipe } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { implementing, type EffectGen } from "effective-modules";
import { DEPLOY_KEY_SECRET, TEAM_ACCESS_TOKEN_SECRET } from "../../public/manifest";
import { ConvexCredential } from "../convex-credential/interface";
import { backendModules } from "../index";
import type { ConvexRequest, IConvexHttp } from "./interface";

const formatSchemaError = SchemaIssue.makeFormatterDefault();

export class ConvexHttpImpl extends implementing(backendModules.ConvexHttp)
  .uses(backendModules.ConvexCredential, HttpClient.HttpClient)
  implements IConvexHttp {
  *send<A>(request: ConvexRequest, response: Schema.Codec<A, unknown, never, never>): EffectGen<A, string> {
    const reply = yield* this.execute(request, { absentOn404: false });
    if (Option.isNone(reply)) return yield* Effect.fail(`Could not ${request.purpose}: Convex answered 404`);
    return yield* this.decode(request, reply.value, response);
  }

  *sendWithoutReply(request: ConvexRequest): EffectGen<void, string> {
    yield* this.execute(request, { absentOn404: false });
  }

  *find<A>(request: ConvexRequest, response: Schema.Codec<A, unknown, never, never>): EffectGen<Option.Option<A>, string> {
    const reply = yield* this.execute(request, { absentOn404: true });
    if (Option.isNone(reply)) return Option.none();
    return Option.some(yield* this.decode(request, reply.value, response));
  }

  /**
   * The Authorization header for one request. The Management API takes only a team access token
   * (https://docs.convex.dev/management-api#authorization); a deployment's own API also takes a deploy key
   * (https://docs.convex.dev/deployment-platform-api#authorization). A Management API call under a deploy key
   * fails naming the step, never silently.
   */
  private *authorization(request: ConvexRequest): EffectGen<Redacted.Redacted<string>, string> {
    const credential = yield* this.dependencies.ConvexCredential.current();
    return yield* ConvexCredential.$match(credential, {
      TeamAccessToken: ({ token }) => Effect.succeed(Redacted.make(`${request.auth} ${Redacted.value(token)}`)),
      DeployKey: ({ key }) => request.auth === "Convex"
        ? Effect.succeed(Redacted.make(`Convex ${Redacted.value(key)}`))
        : Effect.fail(`Could not ${request.purpose}: that is a Management API call, which takes only a team access token; this package deploys with ${DEPLOY_KEY_SECRET}, so the step needs ${TEAM_ACCESS_TOKEN_SECRET} instead`),
    });
  }

  /** Returns the reply's text, or none for a 404 when the caller treats that as absence. */
  private *execute(request: ConvexRequest, options: { readonly absentOn404: boolean }): EffectGen<Option.Option<string>, string> {
    const authorization = yield* this.authorization(request);
    const base = pipe(
      request.method === "GET" ? HttpClientRequest.get(request.url) : HttpClientRequest.post(request.url),
      HttpClientRequest.setHeader("Authorization", Redacted.value(authorization)),
    );
    const httpRequest = request.body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, request.body);

    const response: HttpClientResponse.HttpClientResponse = yield* pipe(
      this.getDependency(HttpClient.HttpClient).execute(httpRequest),
      Effect.mapError((e) => `Could not ${request.purpose}: ${e.message}`),
    );
    const text = yield* pipe(response.text, Effect.mapError((e) => `Could not ${request.purpose}: reading the reply failed: ${e.message}`));
    if (response.status === 404 && options.absentOn404) return Option.none();
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(`Could not ${request.purpose}: Convex answered ${response.status}: ${text.trim()}`);
    }
    return Option.some(text);
  }

  private *decode<A>(request: ConvexRequest, text: string, schema: Schema.Codec<A, unknown, never, never>): EffectGen<A, string> {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => `Could not ${request.purpose}: Convex's reply is not JSON: ${text.slice(0, 200)}`,
    });
    return yield* pipe(
      Schema.decodeUnknownEffect(schema)(parsed),
      Effect.catchTag("SchemaError", (e) => Effect.fail(`Could not ${request.purpose}: Convex's reply has an unexpected shape:\n${formatSchemaError(e.issue)}`)),
    );
  }
}
