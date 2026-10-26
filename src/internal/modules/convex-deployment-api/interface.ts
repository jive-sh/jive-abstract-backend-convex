import type { Option } from "effect";
import type { EffectGen } from "effective-modules";
import type { RequestDestination } from "../../public/manifest";
import type { ConvexDeployment } from "../convex-management-api/interface";

/** The URLs a deployment reports as its own: `CONVEX_CLOUD_URL` and `CONVEX_SITE_URL` inside its functions. */
export interface CanonicalUrls {
  readonly convexCloud: string;
  readonly convexSite: string;
}

/** One deployment's own admin API (https://docs.convex.dev/deployment-platform-api). */
export interface IConvexDeploymentApi {
  /** Every environment variable on the deployment. Fails rather than returning a partial or empty list. */
  listEnvironmentVariables(deployment: ConvexDeployment): EffectGen<ReadonlyMap<string, string>, string>;
  /** Sets each variable in one call; values are never logged. */
  setEnvironmentVariables(deployment: ConvexDeployment, variables: ReadonlyMap<string, string>): EffectGen<void, string>;
  getCanonicalUrls(deployment: ConvexDeployment): EffectGen<CanonicalUrls, string>;
  /** Points a destination's canonical URL at `url`, or back at the default `.convex.cloud`/`.convex.site` URL for none. */
  setCanonicalUrl(input: {
    readonly deployment: ConvexDeployment;
    readonly destination: RequestDestination;
    readonly url: Option.Option<string>;
  }): EffectGen<void, string>;
}
