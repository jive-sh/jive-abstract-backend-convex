import type { EffectGen } from "effective-modules";
import type { PipelineContext } from "jive-abstract-library";

/** One environment of a Convex backend package: what the `deploy-plan` and `deploy` hooks act on. */
export interface IBackend {
  /**
   * The URL the environment is reached at: its first `convexSite` custom domain, else its deployment's
   * `.convex.site` URL. With a team access token, creates the project and deployment when absent, since their URL
   * does not exist before; with a deploy key, the deployment it names, which must match the manifest.
   */
  url(input: { readonly environment: string; readonly context: PipelineContext }): EffectGen<string, string>;
  /**
   * Deploys one environment: sets its environment variables, pushes the functions (with a deploy key minted for
   * this run from a team access token, or the package's own production deploy key), runs `afterDeploy`, adds its
   * custom domains (team access token only), and publishes the matching client.
   */
  deploy(input: { readonly environment: string; readonly context: PipelineContext }): EffectGen<void, string>;
}
