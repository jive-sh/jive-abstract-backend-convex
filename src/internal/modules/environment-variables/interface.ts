import type { EffectGen } from "effective-modules";
import type { EnvironmentVariable } from "../../public/manifest";
import type { ConvexDeployment } from "../convex-management-api/interface";

export interface IEnvironmentVariables {
  /**
   * Brings a deployment's variables in line with the package's declaration. A `value` is written when it
   * differs. A `generateOnce` is generated only when the deployment's list, read successfully, shows none of
   * the variables it writes: replacing a key already in use would make everything sealed with it unreadable,
   * so absence is proven, never assumed. Variables the package does not declare are left alone.
   */
  apply(input: {
    readonly deployment: ConvexDeployment;
    readonly declared: Readonly<Record<string, EnvironmentVariable>>;
  }): EffectGen<void, string>;
}
