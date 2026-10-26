import { Effect } from "effect";
import { effunct, implementing, type EffectGen } from "effective-modules";
import type { EnvironmentVariable } from "../../public/manifest";
import type { ConvexDeployment } from "../convex-management-api/interface";
import { backendModules } from "../index";
import { generateVariables, variablesWrittenBy } from "./generated-values";
import type { IEnvironmentVariables } from "./interface";

export class EnvironmentVariablesImpl extends implementing(backendModules.EnvironmentVariables)
  .uses(backendModules.ConvexDeploymentApi)
  implements IEnvironmentVariables {
  *apply(input: {
    readonly deployment: ConvexDeployment;
    readonly declared: Readonly<Record<string, EnvironmentVariable>>;
  }): EffectGen<void, string> {
    const { deployment, declared } = input;
    const current = yield* Effect.mapError(
      effunct(this.dependencies.ConvexDeploymentApi.listEnvironmentVariables.bind(this.dependencies.ConvexDeploymentApi))(deployment),
      (e) => `${e}\nStopping: without the current list, whether a generate-once key already exists is unknown, and replacing one in use is unrecoverable.`,
    );

    const changes = new Map<string, string>();
    const owned = new Set<string>();
    for (const [name, spec] of Object.entries(declared)) {
      if ("value" in spec) {
        owned.add(name);
        if (current.get(name) === spec.value) {
          yield* Effect.log(`  ${name}: unchanged`);
        } else {
          changes.set(name, spec.value);
          yield* Effect.log(`  ${name}: ${current.has(name) ? "updating" : "setting"}`);
        }
        continue;
      }

      const written = variablesWrittenBy(name, spec.generateOnce);
      written.forEach((variable) => owned.add(variable));
      const present = written.filter((variable) => current.has(variable));
      if (present.length === written.length) {
        yield* Effect.log(`  ${written.join(", ")}: already generated, leaving alone`);
      } else if (present.length === 0) {
        const generated = yield* Effect.promise(() => generateVariables(name, spec.generateOnce));
        generated.forEach((value, variable) => changes.set(variable, value));
        yield* Effect.log(`  ${written.join(", ")}: absent, generated. This deployment holds the only copy.`);
      } else {
        return yield* Effect.fail(
          `${present.join(", ")} exists on ${deployment.name} but ${written.filter((v) => !present.includes(v)).join(", ")} does not. `
          + `They are generated together, so refusing to generate one half; restore or remove the other by hand.`,
        );
      }
    }

    const unmanaged = [...current.keys()].filter((name) => !owned.has(name));
    if (unmanaged.length > 0) yield* Effect.log(`  Not declared by this package, left alone: ${unmanaged.join(", ")}`);

    yield* this.dependencies.ConvexDeploymentApi.setEnvironmentVariables(deployment, changes);
  }
}
