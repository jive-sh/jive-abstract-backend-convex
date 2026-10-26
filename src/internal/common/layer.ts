import { Layer, pipe } from "effect";
import { BunChildProcessSpawner, BunFileSystem, BunPath } from "@effect/platform-bun";
import { FetchHttpClient } from "effect/http";
import { BackendImpl } from "../modules/backend/impl";
import { ClientPackageImpl } from "../modules/client-package/impl";
import { ConvexCliImpl } from "../modules/convex-cli/impl";
import { ConvexDeploymentApiImpl } from "../modules/convex-deployment-api/impl";
import { ConvexHttpImpl } from "../modules/convex-http/impl";
import { ConvexManagementApiImpl } from "../modules/convex-management-api/impl";
import { EnvironmentVariablesImpl } from "../modules/environment-variables/impl";
import { PackageImpl } from "../modules/package/impl";

/** Every module this abstract owns, most-dependent first. */
export const layerLive = pipe(
  BackendImpl.Layer,
  Layer.provideMerge(ClientPackageImpl.Layer),
  Layer.provideMerge(EnvironmentVariablesImpl.Layer),
  Layer.provideMerge(ConvexCliImpl.Layer),
  Layer.provideMerge(ConvexDeploymentApiImpl.Layer),
  Layer.provideMerge(ConvexManagementApiImpl.Layer),
  Layer.provideMerge(ConvexHttpImpl.Layer),
  Layer.provideMerge(PackageImpl.Layer),
  Layer.provideMerge(BunChildProcessSpawner.layer),
  Layer.provideMerge(BunFileSystem.layer),
  Layer.provideMerge(BunPath.layer),
  Layer.provideMerge(FetchHttpClient.layer),
) satisfies Layer.Layer<any, any, never>;
