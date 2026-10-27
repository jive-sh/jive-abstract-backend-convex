import { Effect, Option, Redacted, pipe } from "effect";
import { effunct, implementing, type EffectGen } from "effective-modules";
import type { PipelineContext } from "jive-abstract-library";
import { BACKEND_CONVEX_KEY, DEPLOY_KEY_SECRET, TEAM_ACCESS_TOKEN_SECRET, type CustomDomain, type EnvironmentConfig, type PackageJson, type RequestDestination } from "../../public/manifest";
import { ConvexCredential } from "../convex-credential/interface";
import type { ConvexDeployment } from "../convex-management-api/interface";
import { backendModules } from "../index";
import { deploymentTargetFor, describeTarget, type DeploymentTarget } from "./deployment-target";
import type { IBackend } from "./interface";

const DESTINATIONS: ReadonlyArray<RequestDestination> = ["convexCloud", "convexSite"];

export class BackendImpl extends implementing(backendModules.Backend)
  .uses(
    backendModules.Package,
    backendModules.ConvexCredential,
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
    const clientPlan = yield* clientPackage.plan({ packageJson, environment, context });
    const credential = yield* this.dependencies.ConvexCredential.current();
    const { deployment, config } = yield* this.resolveDeployment({ packageJson, environment, context });

    yield* Effect.log(`Environment variables on ${deployment.name}:`);
    yield* this.dependencies.EnvironmentVariables.apply({ deployment, declared: config.environmentVariables });

    const afterDeploy = Option.fromNullishOr(backend.afterDeploy).pipe(Option.map((after) => after.function));
    yield* ConvexCredential.$match(credential, {
      TeamAccessToken: () => effunct(this.pushFunctionsWithMintedKey.bind(this))({ deployment, environment, context, afterDeploy }),
      DeployKey: ({ key }) => effunct(this.pushFunctions.bind(this))({ deployKey: key, environment, context, afterDeploy }),
    });
    yield* ConvexCredential.$match(credential, {
      TeamAccessToken: () => effunct(this.applyCustomDomains.bind(this))(deployment, config.customDomains),
      // The manifest allows no custom domains with a deploy key; listing the deployment's needs the Management API.
      DeployKey: () => Effect.log(`Custom domains: none declared, and ${DEPLOY_KEY_SECRET} cannot list any others; canonical URLs are left as they are`),
    });

    const urls = yield* this.dependencies.ConvexDeploymentApi.getCanonicalUrls(deployment);
    if (clientPlan.deploy) {
      yield* clientPackage.publish({ packageJson, environment, context, urls });
    } else {
      yield* Effect.log(`Not publishing the client: this environment's version is already on the registry, and callers keep using it`);
    }
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
    const target = deploymentTargetFor(input.environment, input.context);
    const credential = yield* this.dependencies.ConvexCredential.current();
    if (credential._tag === "DeployKey") {
      return { deployment: yield* this.deployKeyDeployment({ credential, target, packageJson: input.packageJson, environment: input.environment }), config };
    }
    const management = this.dependencies.ConvexManagementApi;
    const project = yield* management.ensureProject({ team: backend.team, slug: backend.project });
    yield* Effect.log(`${input.environment} deploys to ${describeTarget(target)} of project "${project.slug}"`);
    const deployment = yield* management.ensureDeployment({ project, target, region: backend.region });
    return { deployment, config };
  }

  /**
   * The deployment a production deploy key names, which must be the one the manifest describes: in its team and
   * project, and referenced by the environment's name. A deploy key cannot create a project or deployment, or a
   * preview deployment per pull request, since only the Management API can.
   */
  private *deployKeyDeployment(input: {
    readonly credential: { readonly key: Redacted.Redacted<string>; readonly deploymentName: string };
    readonly target: DeploymentTarget;
    readonly packageJson: PackageJson;
    readonly environment: string;
  }): EffectGen<ConvexDeployment, string> {
    const { credential, target, packageJson, environment } = input;
    const backend = packageJson.jive[BACKEND_CONVEX_KEY];
    if (target._tag !== "Production") {
      return yield* Effect.fail(`${environment} deploys to a preview deployment per pull request, which only ${TEAM_ACCESS_TOKEN_SECRET} can create; ${DEPLOY_KEY_SECRET} names one existing deployment`);
    }
    const named = yield* this.dependencies.ConvexCredential.deployKeyDeployment(credential);
    const reference = Option.getOrElse(named.reference, () => "(none)");
    const mismatches = [
      ...(named.teamId === backend.team ? [] : [`team ${named.teamId}, not ${backend.team}`]),
      ...(named.projectSlug === backend.project ? [] : [`project "${named.projectSlug}", not "${backend.project}"`]),
      ...(Option.contains(named.reference, target.reference) ? [] : [`reference "${reference}", not "${target.reference}"`]),
    ];
    if (mismatches.length > 0) {
      return yield* Effect.fail(
        `${DEPLOY_KEY_SECRET} names deployment ${named.deployment.name}, which is not ${environment}'s: it has ${mismatches.join(", ")}. `
        + `Use the production deploy key of the deployment jive.${BACKEND_CONVEX_KEY} describes, or set that deployment's reference to "${target.reference}" `
        + `(a project's default production deployment has reference "production"; the Management API's PATCH /v1/deployments/${named.deployment.name} changes it).`,
      );
    }
    yield* Effect.log(`${environment} deploys to ${named.deployment.name} (${describeTarget(target)} of project "${named.projectSlug}"), the deployment ${DEPLOY_KEY_SECRET} names`);
    return named.deployment;
  }

  /**
   * With a team access token, pushes with a deploy key that exists only for this run: minted for this one
   * deployment, deleted when the push finishes or fails, and expiring on its own if this process dies first.
   */
  private *pushFunctionsWithMintedKey(input: {
    readonly deployment: ConvexDeployment;
    readonly environment: string;
    readonly context: PipelineContext;
    readonly afterDeploy: Option.Option<string>;
  }): EffectGen<void, string> {
    const { deployment, context } = input;
    const management = this.dependencies.ConvexManagementApi;
    const push = effunct(this.pushFunctions.bind(this));
    const keyName = `jive ${context.repository.owner}/${context.repository.name} ${context.sourceCommitSha.slice(0, 12)} ${Date.now()}`;

    yield* Effect.scoped(Effect.gen(function* () {
      const deployKey = yield* Effect.acquireRelease(
        effunct(management.createDeployKey.bind(management))({ deployment, name: keyName }),
        () => pipe(
          effunct(management.deleteDeployKey.bind(management))({ deployment, name: keyName }),
          Effect.catchCause((cause) => Effect.logWarning(`Could not delete deploy key "${keyName}"; it expires on its own: ${String(cause)}`)),
        ),
      );
      yield* push({ ...input, deployKey });
    }));
  }

  /** Pushes `convex/` with `deployKey`, then runs `afterDeploy` with it. */
  private *pushFunctions(input: {
    readonly deployKey: Redacted.Redacted<string>;
    readonly environment: string;
    readonly context: PipelineContext;
    readonly afterDeploy: Option.Option<string>;
  }): EffectGen<void, string> {
    const { deployKey, environment, context, afterDeploy } = input;
    const cli = this.dependencies.ConvexCli;
    yield* cli.deploy({ deployKey, message: `${context.repository.owner}/${context.repository.name}@${context.sourceCommitSha}` });
    if (Option.isSome(afterDeploy)) {
      yield* Effect.log(`Running ${afterDeploy.value}`);
      yield* cli.run({ deployKey, functionName: afterDeploy.value, args: { sourceCommitSha: context.sourceCommitSha, environment } });
    }
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
