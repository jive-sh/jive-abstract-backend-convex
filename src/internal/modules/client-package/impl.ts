import { Effect, FileSystem, Option, Schema, pipe } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { resolve } from "node:path";
import { ensureNpm, planNpmRelease, publishPackage, releaseDistTag, releaseVersion, type DeployPlan, type PipelineContext } from "jive-abstract-library";
import { CLIENT_PACKAGE_DIR, CONVEX_CONFIG_FILE, CONVEX_GENERATED_DIR } from "../../common/constants";
import { BACKEND_CONVEX_KEY, type PackageJson } from "../../public/manifest";
import type { CanonicalUrls } from "../convex-deployment-api/interface";
import { backendModules } from "../index";
import type { IClientPackage } from "./interface";

/** Generated files the client ships. `server.*` is left out: it is for writing functions, not calling them. */
const GENERATED_FILES = ["api.js", "api.d.ts", "dataModel.d.ts"] as const;

const PROVIDER_HOSTS = { Github: "github.com", Gitlab: "gitlab.com" } as const satisfies Record<PipelineContext["provider"], string>;

const ConvexJson = Schema.Struct({
  codegen: Schema.optionalKey(Schema.Struct({
    staticApi: Schema.optionalKey(Schema.Boolean),
    staticDataModel: Schema.optionalKey(Schema.Boolean),
  })),
});

/** The registry the client publishes to, when the manifest names one rather than using npm's configured registry. */
function registryOf(packageJson: PackageJson): Option.Option<string> {
  return pipe(
    Option.flatMap(packageJson.publishConfig, (config) => Option.fromNullishOr(config["registry"])),
    Option.map((registry) => String(registry)),
  );
}

function indexJs(urls: CanonicalUrls, deployment: { environment: string; sourceCommitSha: string; version: string }): string {
  return [
    `export { api } from "./_generated/api.js";`,
    `/** The URL to pass to ConvexClient or ConvexReactClient: this environment's canonical Convex API URL. */`,
    `export const convexUrl = ${JSON.stringify(urls.convexCloud)};`,
    `/** Where this environment's HTTP actions are served. */`,
    `export const convexSiteUrl = ${JSON.stringify(urls.convexSite)};`,
    `/** Which deploy these functions came from. */`,
    `export const deployment = ${JSON.stringify(deployment)};`,
    ``,
  ].join("\n");
}

const INDEX_D_TS = [
  `export { api } from "./_generated/api.js";`,
  `export type { DataModel, Doc, Id, TableNames } from "./_generated/dataModel.js";`,
  `export declare const convexUrl: string;`,
  `export declare const convexSiteUrl: string;`,
  `export declare const deployment: { readonly environment: string; readonly sourceCommitSha: string; readonly version: string };`,
  ``,
].join("\n");

export class ClientPackageImpl extends implementing(backendModules.ClientPackage)
  .uses(FileSystem.FileSystem)
  implements IClientPackage {
  *checkPublishable(packageJson: PackageJson): EffectGen<void, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    const text = yield* pipe(
      fs.readFileString(CONVEX_CONFIG_FILE),
      Effect.mapError(() => `${CONVEX_CONFIG_FILE} is missing. ${this.staticCodegenAdvice()}`),
    );
    const config = yield* pipe(
      Schema.decodeUnknownEffect(Schema.fromJsonString(ConvexJson))(text),
      Effect.mapError((e) => `${CONVEX_CONFIG_FILE} cannot be read: ${e.message}`),
    );
    if (config.codegen?.staticApi !== true || config.codegen.staticDataModel !== true) {
      return yield* Effect.fail(this.staticCodegenAdvice());
    }
    const convexRange = Option.flatMap(packageJson.dependencies, (dependencies) => Option.fromNullishOr(dependencies["convex"]));
    if (Option.isNone(convexRange)) {
      return yield* Effect.fail(`"convex" must be in dependencies: the published client declares it as a peer dependency with the same range`);
    }
  }

  *plan(input: {
    readonly packageJson: PackageJson;
    readonly environment: string;
    readonly context: PipelineContext;
  }): EffectGen<DeployPlan, string> {
    const { packageJson, environment, context } = input;
    return yield* planNpmRelease({
      name: packageJson.name,
      version: releaseVersion(packageJson.version, environment, context.sourceCommitSha),
      registry: registryOf(packageJson),
    });
  }

  *publish(input: {
    readonly packageJson: PackageJson;
    readonly environment: string;
    readonly context: PipelineContext;
    readonly urls: CanonicalUrls;
  }): EffectGen<void, string> {
    const { packageJson, environment, context, urls } = input;
    const fs = this.getDependency(FileSystem.FileSystem);
    const packageDir = resolve(CLIENT_PACKAGE_DIR);
    const generatedDir = resolve(packageDir, "_generated");
    const version = releaseVersion(packageJson.version, environment, context.sourceCommitSha);
    const distTag = releaseDistTag(environment, context.sourceCommitSha);
    const convexRange = Option.getOrElse(
      Option.flatMap(packageJson.dependencies, (dependencies) => Option.fromNullishOr(dependencies["convex"])),
      () => "*",
    );

    const write = (path: string, text: string) =>
      Effect.mapError(fs.writeFileString(path, text), (e) => `Cannot write ${path}: ${e.message}`);
    yield* Effect.mapError(fs.remove(packageDir, { recursive: true, force: true }), (e) => `Cannot clear ${packageDir}: ${e.message}`);
    yield* Effect.mapError(fs.makeDirectory(generatedDir, { recursive: true }), (e) => `Cannot create ${generatedDir}: ${e.message}`);
    for (const file of GENERATED_FILES) {
      yield* Effect.mapError(
        fs.copyFile(resolve(CONVEX_GENERATED_DIR, file), resolve(generatedDir, file)),
        (e) => `Cannot copy ${CONVEX_GENERATED_DIR}/${file} into the client: ${e.message}`,
      );
    }
    yield* write(resolve(packageDir, "index.js"), indexJs(urls, { environment, sourceCommitSha: context.sourceCommitSha, version }));
    yield* write(resolve(packageDir, "index.d.ts"), INDEX_D_TS);
    yield* write(resolve(packageDir, "package.json"), `${JSON.stringify({
      name: packageJson.name,
      version,
      license: packageJson.license,
      ...Option.match(packageJson.description, { onNone: () => ({}), onSome: (description) => ({ description }) }),
      type: "module",
      // npm's provenance check for trusted publishing compares this with the repository that ran the workflow.
      repository: { type: "git", url: `git+https://${PROVIDER_HOSTS[context.provider]}/${context.repository.owner}/${context.repository.name}.git` },
      exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
      peerDependencies: { convex: convexRange },
      ...Option.match(packageJson.publishConfig, { onNone: () => ({}), onSome: (publishConfig) => ({ publishConfig }) }),
    }, null, 2)}\n`);

    yield* Effect.log(`Publishing the client ${packageJson.name}@${version} under "${distTag}" (Convex URL ${urls.convexCloud})`);
    yield* ensureNpm();
    yield* publishPackage({
      packageDir,
      outDir: resolve("dist"),
      version,
      distTag,
      provisionWithJive: packageJson.jive[BACKEND_CONVEX_KEY].provisionWithJive,
    });
  }

  private staticCodegenAdvice(): string {
    return `${CONVEX_CONFIG_FILE} must set {"codegen": {"staticApi": true, "staticDataModel": true}} so the published client's types `
      + `stand alone, without the backend's source (https://docs.convex.dev/config/convex.json).`;
  }
}
