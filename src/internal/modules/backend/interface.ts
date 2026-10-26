import type { EffectGen } from "effective-modules";
import type { PipelineContext } from "jive-abstract-library";

/** One environment of a Convex backend package: what the `deploy-url` and `deploy` hooks act on. */
export interface IBackend {
  /**
   * The URL the environment is reached at: its first `convexSite` custom domain, else its deployment's
   * `.convex.site` URL. Creates the project and deployment when absent, since their URL does not exist before.
   */
  url(input: { readonly environment: string; readonly context: PipelineContext }): EffectGen<string, string>;
  /**
   * Deploys one environment: sets its environment variables, pushes the functions with a deploy key minted
   * for this run, runs `afterDeploy`, adds its custom domains, and publishes the matching client.
   */
  deploy(input: { readonly environment: string; readonly context: PipelineContext }): EffectGen<void, string>;
}
