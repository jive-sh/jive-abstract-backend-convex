import type { Option, Schema } from "effect";
import type { EffectGen } from "effective-modules";

/** How a Convex API expects the team access token: the Management API takes `Bearer <token>`, a deployment's own API `Convex <token>`. */
export type ConvexAuthScheme = "Bearer" | "Convex";

export interface ConvexRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly auth: ConvexAuthScheme;
  readonly body?: unknown;
  /** What the call does, for error messages, e.g. `create deployment "production"`. */
  readonly purpose: string;
}

export interface IConvexHttp {
  /**
   * Calls a Convex API with the team access token and decodes the JSON reply. Any non-2xx status fails with
   * the status and Convex's reply, which carries its own `code` and `message`, so a refused call says why.
   */
  send<A>(request: ConvexRequest, response: Schema.Codec<A, unknown, never, never>): EffectGen<A, string>;
  /** Like `send`, for a call whose success has no body worth reading. */
  sendWithoutReply(request: ConvexRequest): EffectGen<void, string>;
  /** Like `send`, but a 404 is absence rather than failure. */
  find<A>(request: ConvexRequest, response: Schema.Codec<A, unknown, never, never>): EffectGen<Option.Option<A>, string>;
}
