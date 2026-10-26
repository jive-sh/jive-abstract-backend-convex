import { Effect, Option, pipe } from "effect";
import { effunct, implementing, type EffectGen } from "effective-modules";
import type { PipelineContext } from "jive-abstract-library";
import { BACKEND_CONVEX_KEY, type CustomDomain, type EnvironmentConfig, type PackageJson, type RequestDestination } from "../../public/manifest";
import type { ConvexDeployment } from "../convex-management-api/interface";
import { backendModules } from "../index";
import { deploymentTargetFor, describeTarget } from "./deployment-target";
import type { IBackend } from "./interface";

const DESTINATIONS: ReadonlyArray<RequestDestination> = ["convexCloud", "convexSite"];

export class BackendImpl extends implementing(backendModules.Backend)
  .uses(
    backendModules.Package,
    backendModules.ConvexManagementApi,
    backendModules.ConvexDeploymentApi,
    backendModules.ConvexCli,
    backendModules.EnvironmentVariables,
    backendModules.ClientPackage,
  )
  implements IBackend {
  *url(input: { readonly environment: string; readonly context: PipelineContext }): EffectGen<string, string> {
    const packageJson = yield* this.dependencies.Package.load();
    const { deployment, config } = yield* this.resolveDeployment({ packageJson, ...input });
    const siteDomain = config.customDomains.find((domain) => domain.destination === "convexSite");
    if (siteDomain !== undefined) return `https://${siteDomain.domain}`;
    return (yield* this.dependencies.ConvexDeploymentApi.getCanonicalUrls(deployment)).convexSite;
  }

  *deploy(input: { readonly environment: string; readonly context: PipelineContext }): EffectGen<void, string> {
    const { environment, context } = input;
    const packageJson = yield* this.dependencies.Package.load();
    const backend = packageJson.jive[BACKEND_CONVEX_KEY];
    const clientPackage = this.dependencies.ClientPackage;

    yield* clientPackage.checkPublishable(packageJson);
    yield* clientPackage.checkUnpublished({ packageJson, environment, context });
    const { deployment, config } = yield* this.resolveDeployment({ packageJson, environment, context });

    yield* Effect.log(`Environment variables on ${deployment.name}:`);
    yield* this.dependencies.EnvironmentVariables.apply({ deployment, declared: config.environmentVariables });

    yield* this.pushFunctions({
      deployment,
      environment,
      context,
      afterDeploy: Option.fromNullishOr(backend.afterDeploy).pipe(Option.map((after) => after.function)),
    });
    yield* this.applyCustomDomains(deployment, config.customDomains);

    const urls = yield* this.dependencies.ConvexDeploymentApi.getCanonicalUrls(deployment);
    yield* clientPackage.publish({ packageJson, environment, context, urls });
    yield* Effect.log(`Deployed ${packageJson.name} to ${environment}: ${urls.convexCloud}`);
  }

  private *resolveDeployment(input: {
    readonly packageJson: PackageJson;
    readonly environment: string;
    readonly context: PipelineContext;
  }): EffectGen<{ readonly deployment: ConvexDeployment; readonly config: EnvironmentConfig }, string> {
    const backend = input.packageJson.jive[BACKEND_CONVEX_KEY];
    const config = backend.environments[input.environment];
    if (config === undefined) {
      return yield* Effect.fail(`jive.${BACKEND_CONVEX_KEY}.environments has no entry for "${input.environment}"`);
    }
    const management = this.dependencies.ConvexManagementApi;
    const project = yield* management.ensureProject({ team: backend.team, slug: backend.project });
    const target = deploymentTargetFor(input.environment, input.context);
    yield* Effect.log(`${input.environment} deploys to ${describeTarget(target)} of project "${project.slug}"`);
    const deployment = yield* management.ensureDeployment({ project, target, region: backend.region });
    return { deployment, config };
  }

  /**
   * Pushes with a deploy key that exists only for this run: minted for this one deployment, deleted when the
   * push finishes or fails, and expiring on its own if this process dies first. CI holds no per-deployment key.
   */
  private *pushFunctions(input: {
    readonly deployment: ConvexDeployment;
    readonly environment: string;
    readonly context: PipelineContext;
    readonly afterDeploy: Option.Option<string>;
  }): EffectGen<void, string> {
    const { deployment, environment, context, afterDeploy } = input;
    const management = this.dependencies.ConvexManagementApi;
    const cli = this.dependencies.ConvexCli;
    const keyName = `jive ${context.repository.owner}/${context.repository.name} ${context.sourceCommitSha.slice(0, 12)} ${Date.now()}`;

    yield* Effect.scoped(Effect.gen(function* () {
      const deployKey = yield* Effect.acquireRelease(
        effunct(management.createDeployKey.bind(management))({ deployment, name: keyName }),
        () => pipe(
          effunct(management.deleteDeployKey.bind(management))({ deployment, name: keyName }),
          Effect.catchCause((cause) => Effect.logWarning(`Could not delete deploy key "${keyName}"; it expires on its own: ${String(cause)}`)),
        ),
      );
      yield* effunct(cli.deploy.bind(cli))({ deployKey, message: `${context.repository.owner}/${context.repository.name}@${context.sourceCommitSha}` });
      if (Option.isSome(afterDeploy)) {
        yield* Effect.log(`Running ${afterDeploy.value}`);
        yield* effunct(cli.run.bind(cli))({
          deployKey,
          functionName: afterDeploy.value,
          args: { sourceCommitSha: context.sourceCommitSha, environment },
        });
      }
    }));
  }

  /**
   * Adds every declared domain the deployment lacks, then points each destination's canonical URL at its
   * canonical domain once Convex has verified it, and at Convex's default otherwise. Convex accepts an
   * unverified domain as canonical, which would send every client to a host that does not answer yet.
   * Domains the package no longer declares are reported, never deleted: removing one takes a live hostname down.
   */
  private *applyCustomDomains(deployment: ConvexDeployment, declared: ReadonlyArray<CustomDomain>): EffectGen<void, string> {
    const management = this.dependencies.ConvexManagementApi;
    const existing = yield* management.listCustomDomains(deployment);
    for (const domain of declared) {
      if (existing.some((e) => e.domain === domain.domain && e.destination === domain.destination)) continue;
      yield* Effect.log(`Adding custom domain ${domain.domain} (${domain.destination})`);
      yield* management.createCustomDomain({ deployment, domain: domain.domain, destination: domain.destination });
    }
    for (const domain of existing) {
      if (!declared.some((d) => d.domain === domain.domain && d.destination === domain.destination)) {
        yield* Effect.logWarning(`${domain.domain} (${domain.destination}) is on ${deployment.name} but not declared; leaving it`);
      }
    }

    const statuses = yield* management.listCustomDomains(deployment);
    const current = yield* this.dependencies.ConvexDeploymentApi.getCanonicalUrls(deployment);
    for (const destination of DESTINATIONS) {
      const canonical = declared.find((d) => d.canonical && d.destination === destination);
      const verified = canonical !== undefined
        && statuses.some((s) => s.domain === canonical.domain && s.destination === destination && s.verified);
      if (canonical !== undefined && !verified) {
        yield* Effect.logWarning(
          `${canonical.domain} is not verified yet, so ${destination} keeps Convex's default URL. Create a CNAME from `
          + `${canonical.domain} to convex.domains and the TXT record at _convex_domains.${canonical.domain} that the Convex `
          + `dashboard shows; the next deploy after verification makes it canonical.`,
        );
      }
      const wanted = verified ? Option.some(`https://${canonical.domain}`) : Option.none<string>();
      const currentUrl = destination === "convexCloud" ? current.convexCloud : current.convexSite;
      const isDefault = /\.convex\.(cloud|site)$/.test(new URL(currentUrl).hostname);
      const unchanged = Option.match(wanted, { onNone: () => isDefault, onSome: (url) => url === currentUrl });
      if (unchanged) continue;
      yield* Effect.log(`Setting the ${destination} canonical URL to ${Option.getOrElse(wanted, () => "Convex's default")}`);
      yield* this.dependencies.ConvexDeploymentApi.setCanonicalUrl({ deployment, destination, url: wanted });
    }
  }
}
