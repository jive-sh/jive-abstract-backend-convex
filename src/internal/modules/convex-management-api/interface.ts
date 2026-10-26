import type { Option, Redacted } from "effect";
import type { EffectGen } from "effective-modules";
import type { RequestDestination } from "../../public/manifest";
import type { DeploymentTarget } from "../backend/deployment-target";

export interface ConvexProject {
  readonly id: number;
  readonly slug: string;
  readonly teamId: number;
}

export interface ConvexDeployment {
  /** Convex's generated name, e.g. `happy-otter-123`. */
  readonly name: string;
  /** Always the deployment's `.convex.cloud` URL, whatever its canonical URL is; the deployment's own API lives here. */
  readonly cloudUrl: string;
}

export interface CustomDomainStatus {
  readonly domain: string;
  readonly destination: RequestDestination;
  readonly verified: boolean;
}

export interface IConvexManagementApi {
  /** The team's project with this slug, created under that name when absent. Fails if Convex picks another slug. */
  ensureProject(input: { readonly team: number; readonly slug: string }): EffectGen<ConvexProject, string>;
  /** The project's deployment for a target, created in `region` when absent. */
  ensureDeployment(input: {
    readonly project: ConvexProject;
    readonly target: DeploymentTarget;
    readonly region: string;
  }): EffectGen<ConvexDeployment, string>;
  /**
   * A deploy key for one deployment that can push code and run functions, expiring on its own after
   * `DEPLOY_KEY_LIFETIME_MINUTES` in case `deleteDeployKey` never runs.
   */
  createDeployKey(input: { readonly deployment: ConvexDeployment; readonly name: string }): EffectGen<Redacted.Redacted<string>, string>;
  deleteDeployKey(input: { readonly deployment: ConvexDeployment; readonly name: string }): EffectGen<void, string>;
  listCustomDomains(deployment: ConvexDeployment): EffectGen<ReadonlyArray<CustomDomainStatus>, string>;
  createCustomDomain(input: {
    readonly deployment: ConvexDeployment;
    readonly domain: string;
    readonly destination: RequestDestination;
  }): EffectGen<void, string>;
  /** Deletes a project and every deployment in it. Used only by this abstract's own end-to-end test. */
  deleteProject(project: ConvexProject): EffectGen<void, string>;
  findProject(input: { readonly team: number; readonly slug: string }): EffectGen<Option.Option<ConvexProject>, string>;
}
