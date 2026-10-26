import { Data, type Option, type Redacted } from "effect";
import type { EffectGen } from "effective-modules";
import type { ConvexDeployment } from "../convex-management-api/interface";

/**
 * The one credential a run authenticates to Convex with, as the package's `jive.cicd.requiredSecrets` names it.
 * A team access token reaches the Management API; a production deploy key reaches only its own deployment.
 */
export type ConvexCredential = Data.TaggedEnum<{
  TeamAccessToken: { readonly token: Redacted.Redacted<string> };
  DeployKey: { readonly key: Redacted.Redacted<string>; readonly deploymentName: string };
}>;
export const ConvexCredential = Data.taggedEnum<ConvexCredential>();

/** The deployment a production deploy key names, and where Convex says it lives. */
export interface DeployKeyDeployment {
  readonly deployment: ConvexDeployment;
  readonly teamId: number;
  readonly projectSlug: string;
  /** The deployment's reference, e.g. "latest"; none when Convex reports none. */
  readonly reference: Option.Option<string>;
}

/** How this abstract authenticates to Convex. Nothing else reads the credential's environment variables. */
export interface IConvexCredential {
  /**
   * The credential the package's manifest names, read from that environment variable. Fails when it is unset,
   * when the other credential's variable is set too (which of the two acts would be a guess), or when a deploy
   * key is not a production one.
   */
  current(): EffectGen<ConvexCredential, string>;
  /** Which deployment a production deploy key names, asked of Convex with the key alone. */
  deployKeyDeployment(credential: {
    readonly key: Redacted.Redacted<string>;
    readonly deploymentName: string;
  }): EffectGen<DeployKeyDeployment, string>;
}
