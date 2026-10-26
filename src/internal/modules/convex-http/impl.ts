import { Effect, Option, Redacted, Schema, SchemaIssue, pipe } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { implementing, type EffectGen } from "effective-modules";
import { TEAM_ACCESS_TOKEN_SECRET } from "../../public/manifest";
import { backendModules } from "../index";
import type { ConvexRequest, IConvexHttp } from "./interface";

const formatSchemaError = SchemaIssue.makeFormatterDefault();

export class ConvexHttpImpl extends implementing(backendModules.ConvexHttp).uses(HttpClient.HttpClient) implements IConvexHttp {
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

  private *teamAccessToken(): EffectGen<Redacted.Redacted<string>, string> {
    const token = yield* Effect.sync(() => process.env[TEAM_ACCESS_TOKEN_SECRET]);
    if (token === undefined || token === "") {
      return yield* Effect.fail(
        `${TEAM_ACCESS_TOKEN_SECRET} is not set. It is a Convex team access token (Convex dashboard, team settings) `
        + `stored as a repository secret and listed in jive.cicd.requiredSecrets.`,
      );
    }
    return Redacted.make(token);
  }

  /** Returns the reply's text, or none for a 404 when the caller treats that as absence. */
  private *execute(request: ConvexRequest, options: { readonly absentOn404: boolean }): EffectGen<Option.Option<string>, string> {
    const token = yield* this.teamAccessToken();
    const base = pipe(
      request.method === "GET" ? HttpClientRequest.get(request.url) : HttpClientRequest.post(request.url),
      HttpClientRequest.setHeader("Authorization", `${request.auth} ${Redacted.value(token)}`),
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
