import { interfaces } from "effective-modules";
import type { IBackend } from "./backend/interface";
import type { IClientPackage } from "./client-package/interface";
import type { IConvexCli } from "./convex-cli/interface";
import type { IConvexCredential } from "./convex-credential/interface";
import type { IConvexDeploymentApi } from "./convex-deployment-api/interface";
import type { IConvexHttp } from "./convex-http/interface";
import type { IConvexManagementApi } from "./convex-management-api/interface";
import type { IEnvironmentVariables } from "./environment-variables/interface";
import type { IPackage } from "./package/interface";

export enum BackendModules {
  Package = "Package",
  ConvexCredential = "ConvexCredential",
  ConvexHttp = "ConvexHttp",
  ConvexManagementApi = "ConvexManagementApi",
  ConvexDeploymentApi = "ConvexDeploymentApi",
  ConvexCli = "ConvexCli",
  EnvironmentVariables = "EnvironmentVariables",
  ClientPackage = "ClientPackage",
  Backend = "Backend",
}

export const backendModules = interfaces<BackendModules, {
  Package: IPackage;
  ConvexCredential: IConvexCredential;
  ConvexHttp: IConvexHttp;
  ConvexManagementApi: IConvexManagementApi;
  ConvexDeploymentApi: IConvexDeploymentApi;
  ConvexCli: IConvexCli;
  EnvironmentVariables: IEnvironmentVariables;
  ClientPackage: IClientPackage;
  Backend: IBackend;
}>(BackendModules);
