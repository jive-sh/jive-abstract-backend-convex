import { Option, Schema } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import type { RequestDestination } from "../../public/manifest";
import type { ConvexDeployment } from "../convex-management-api/interface";
import { backendModules } from "../index";
import type { CanonicalUrls, IConvexDeploymentApi } from "./interface";

const EnvironmentVariables = Schema.Struct({ environmentVariables: Schema.Record(Schema.String, Schema.String) });
const CanonicalUrlsReply = Schema.Struct({ convexCloudUrl: Schema.String, convexSiteUrl: Schema.String });

function apiUrl(deployment: ConvexDeployment, path: string): string {
  return `${deployment.cloudUrl}/api/v1/${path}`;
}

export class ConvexDeploymentApiImpl extends implementing(backendModules.ConvexDeploymentApi)
  .uses(backendModules.ConvexHttp)
  implements IConvexDeploymentApi {
  *listEnvironmentVariables(deployment: ConvexDeployment): EffectGen<ReadonlyMap<string, string>, string> {
    const { environmentVariables } = yield* this.dependencies.ConvexHttp.send({
      method: "GET",
      url: apiUrl(deployment, "list_environment_variables"),
      auth: "Convex",
      purpose: `list the environment variables of ${deployment.name}`,
    }, EnvironmentVariables);
    return new Map(Object.entries(environmentVariables));
  }

  *setEnvironmentVariables(deployment: ConvexDeployment, variables: ReadonlyMap<string, string>): EffectGen<void, string> {
    if (variables.size === 0) return;
    yield* this.dependencies.ConvexHttp.sendWithoutReply({
      method: "POST",
      url: apiUrl(deployment, "update_environment_variables"),
      auth: "Convex",
      body: { changes: [...variables].map(([name, value]) => ({ name, value })) },
      purpose: `set ${[...variables.keys()].join(", ")} on ${deployment.name}`,
    });
  }

  *getCanonicalUrls(deployment: ConvexDeployment): EffectGen<CanonicalUrls, string> {
    const urls = yield* this.dependencies.ConvexHttp.send({
      method: "GET",
      url: apiUrl(deployment, "get_canonical_urls"),
      auth: "Convex",
      purpose: `read the canonical URLs of ${deployment.name}`,
    }, CanonicalUrlsReply);
    return { convexCloud: urls.convexCloudUrl, convexSite: urls.convexSiteUrl };
  }

  *setCanonicalUrl(input: {
    readonly deployment: ConvexDeployment;
    readonly destination: RequestDestination;
    readonly url: Option.Option<string>;
  }): EffectGen<void, string> {
    yield* this.dependencies.ConvexHttp.sendWithoutReply({
      method: "POST",
      url: apiUrl(input.deployment, "update_canonical_url"),
      auth: "Convex",
      body: Option.match(input.url, {
        onNone: () => ({ requestDestination: input.destination }),
        onSome: (url) => ({ requestDestination: input.destination, url }),
      }),
      purpose: `set the ${input.destination} canonical URL of ${input.deployment.name}`,
    });
  }
}
