import { Effect, Option, Redacted, Schema } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { CONVEX_MANAGEMENT_API_URL, DEPLOY_KEY_LIFETIME_MINUTES } from "../../common/constants";
import type { RequestDestination } from "../../public/manifest";
import { describeTarget, type DeploymentTarget } from "../backend/deployment-target";
import { backendModules } from "../index";
import type { ConvexDeployment, ConvexProject, CustomDomainStatus, IConvexManagementApi } from "./interface";

/** Schemas for the parts of the Management API replies this module reads (https://api.convex.dev/v1/openapi.json). */
const Project = Schema.Struct({ id: Schema.Number, slug: Schema.String, teamId: Schema.Number });
const CreatedProject = Schema.Struct({ id: Schema.Number, slug: Schema.String });
const Deployment = Schema.Struct({
  name: Schema.String,
  deploymentType: Schema.String,
  reference: Schema.String,
  previewIdentifier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  deploymentUrl: Schema.String,
  kind: Schema.String,
});
type Deployment = typeof Deployment.Type;
const DeployKey = Schema.Struct({ deployKey: Schema.String });
const CustomDomains = Schema.Struct({
  domains: Schema.Array(Schema.Struct({
    domain: Schema.String,
    requestDestination: Schema.Literals(["convexCloud", "convexSite"]),
    verificationTime: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  })),
});

/** What a deploy key minted by a hook may do: push code, and run the after-deploy function even if internal. */
const DEPLOY_KEY_ACTIONS = [
  "deployment:deploy",
  "deployment:functions:runInternalQueries",
  "deployment:functions:runInternalMutations",
  "deployment:functions:runInternalActions",
] as const;

function matchesTarget(deployment: Deployment, target: DeploymentTarget): boolean {
  if (deployment.kind !== "cloud") return false;
  return target._tag === "Production"
    ? deployment.deploymentType === "prod" && deployment.reference === target.reference
    // Convex rewrites a preview's reference (`pr-1` becomes `preview/pr-1`) but keeps the identifier it was given.
    : deployment.deploymentType === "preview" && deployment.previewIdentifier === target.previewIdentifier;
}

export class ConvexManagementApiImpl extends implementing(backendModules.ConvexManagementApi)
  .uses(backendModules.ConvexHttp)
  implements IConvexManagementApi {
  *findProject(input: { readonly team: number; readonly slug: string }): EffectGen<Option.Option<ConvexProject>, string> {
    return yield* this.dependencies.ConvexHttp.find({
      method: "GET",
      url: `${CONVEX_MANAGEMENT_API_URL}/teams/${input.team}/projects/${encodeURIComponent(input.slug)}`,
      auth: "Bearer",
      purpose: `look up project "${input.slug}" in team ${input.team}`,
    }, Project);
  }

  *ensureProject(input: { readonly team: number; readonly slug: string }): EffectGen<ConvexProject, string> {
    const existing = yield* this.findProject(input);
    if (Option.isSome(existing)) {
      yield* Effect.log(`Convex project "${input.slug}" exists (id ${existing.value.id})`);
      return existing.value;
    }

    yield* Effect.log(`Creating Convex project "${input.slug}" in team ${input.team}`);
    const created = yield* this.dependencies.ConvexHttp.send({
      method: "POST",
      url: `${CONVEX_MANAGEMENT_API_URL}/teams/${input.team}/create_project`,
      auth: "Bearer",
      body: { projectName: input.slug },
      purpose: `create project "${input.slug}" in team ${input.team}`,
    }, CreatedProject);
    if (created.slug !== input.slug) {
      return yield* Effect.fail(
        `Convex created project "${input.slug}" with slug "${created.slug}" (id ${created.id}), so later deploys would not find it. `
        + `Set jive.backend-convex.project to "${created.slug}" or delete that project and choose another name.`,
      );
    }
    return { id: created.id, slug: created.slug, teamId: input.team };
  }

  *ensureDeployment(input: {
    readonly project: ConvexProject;
    readonly target: DeploymentTarget;
    readonly region: string;
  }): EffectGen<ConvexDeployment, string> {
    const { project, target, region } = input;
    const deployments = yield* this.dependencies.ConvexHttp.send({
      method: "GET",
      url: `${CONVEX_MANAGEMENT_API_URL}/projects/${project.id}/list_deployments`,
      auth: "Bearer",
      purpose: `list the deployments of project "${project.slug}"`,
    }, Schema.Array(Deployment));

    const existing = deployments.find((deployment) => matchesTarget(deployment, target));
    if (existing !== undefined) {
      yield* Effect.log(`Using ${describeTarget(target)}: ${existing.name}`);
      return { name: existing.name, cloudUrl: existing.deploymentUrl };
    }

    yield* Effect.log(`Creating ${describeTarget(target)} in ${region}`);
    const created = yield* this.dependencies.ConvexHttp.send({
      method: "POST",
      url: `${CONVEX_MANAGEMENT_API_URL}/projects/${project.id}/create_deployment`,
      auth: "Bearer",
      body: target._tag === "Production"
        ? { type: "prod", reference: target.reference, region }
        : { type: "preview", reference: target.previewIdentifier, region },
      purpose: `create ${describeTarget(target)} in project "${project.slug}"`,
    }, Deployment);
    return { name: created.name, cloudUrl: created.deploymentUrl };
  }

  *createDeployKey(input: { readonly deployment: ConvexDeployment; readonly name: string }): EffectGen<Redacted.Redacted<string>, string> {
    const expiresAt = Date.now() + DEPLOY_KEY_LIFETIME_MINUTES * 60_000;
    const { deployKey } = yield* this.dependencies.ConvexHttp.send({
      method: "POST",
      url: `${CONVEX_MANAGEMENT_API_URL}/deployments/${input.deployment.name}/create_deploy_key`,
      auth: "Bearer",
      body: { name: input.name, expiresAt, allowedActions: DEPLOY_KEY_ACTIONS },
      purpose: `create deploy key "${input.name}" for ${input.deployment.name}`,
    }, DeployKey);
    return Redacted.make(deployKey);
  }

  *deleteDeployKey(input: { readonly deployment: ConvexDeployment; readonly name: string }): EffectGen<void, string> {
    yield* this.dependencies.ConvexHttp.sendWithoutReply({
      method: "POST",
      url: `${CONVEX_MANAGEMENT_API_URL}/deployments/${input.deployment.name}/delete_deploy_key`,
      auth: "Bearer",
      body: { id: input.name },
      purpose: `delete deploy key "${input.name}" from ${input.deployment.name}`,
    });
  }

  *listCustomDomains(deployment: ConvexDeployment): EffectGen<ReadonlyArray<CustomDomainStatus>, string> {
    const { domains } = yield* this.dependencies.ConvexHttp.send({
      method: "GET",
      url: `${CONVEX_MANAGEMENT_API_URL}/deployments/${deployment.name}/custom_domains`,
      auth: "Bearer",
      purpose: `list the custom domains of ${deployment.name}`,
    }, CustomDomains);
    return domains.map((domain) => ({
      domain: domain.domain,
      destination: domain.requestDestination,
      verified: domain.verificationTime !== undefined && domain.verificationTime !== null,
    }));
  }

  *createCustomDomain(input: {
    readonly deployment: ConvexDeployment;
    readonly domain: string;
    readonly destination: RequestDestination;
  }): EffectGen<void, string> {
    yield* this.dependencies.ConvexHttp.sendWithoutReply({
      method: "POST",
      url: `${CONVEX_MANAGEMENT_API_URL}/deployments/${input.deployment.name}/create_custom_domain`,
      auth: "Bearer",
      body: { domain: input.domain, requestDestination: input.destination },
      purpose: `add custom domain ${input.domain} (${input.destination}) to ${input.deployment.name}`,
    });
  }

  *deleteProject(project: ConvexProject): EffectGen<void, string> {
    yield* this.dependencies.ConvexHttp.sendWithoutReply({
      method: "POST",
      url: `${CONVEX_MANAGEMENT_API_URL}/projects/${project.id}/delete`,
      auth: "Bearer",
      purpose: `delete project "${project.slug}"`,
    });
  }
}
