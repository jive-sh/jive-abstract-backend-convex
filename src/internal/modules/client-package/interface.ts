import type { EffectGen } from "effective-modules";
import type { PipelineContext } from "jive-abstract-library";
import type { PackageJson } from "../../public/manifest";
import type { CanonicalUrls } from "../convex-deployment-api/interface";

/**
 * The npm package a Convex backend publishes for its callers: the generated `api` and data model types, plus
 * the URLs of the one deployment those functions were pushed to. It is published under the backend package's
 * own name, once per environment, under that environment's dist-tag, so the version a caller installs names
 * the deployment it talks to.
 */
export interface IClientPackage {
  /**
   * Checks what publishing will need before anything is deployed: `convex.json` asks for static codegen, so
   * the generated types stand alone without the backend's source, and `convex` is a dependency.
   */
  checkPublishable(packageJson: PackageJson): EffectGen<void, string>;
  /** Fails when this environment's version is already on the registry, so a deploy that cannot publish stops before pushing functions. */
  checkUnpublished(input: {
    readonly packageJson: PackageJson;
    readonly environment: string;
    readonly context: PipelineContext;
  }): EffectGen<void, string>;
  /** Assembles the client from the freshly pushed `convex/_generated` and publishes it. */
  publish(input: {
    readonly packageJson: PackageJson;
    readonly environment: string;
    readonly context: PipelineContext;
    readonly urls: CanonicalUrls;
  }): EffectGen<void, string>;
}
