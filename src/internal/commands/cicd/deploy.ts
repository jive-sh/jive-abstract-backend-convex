import { makeDeployCommand } from "../../common/command";
import { backendModules } from "../../modules";

export const deploy = makeDeployCommand(
  "deploy",
  "push the Convex functions to this environment's deployment and publish the matching client to npm",
  function* ({ environment, context }) {
    yield* (yield* backendModules.Backend).deploy({ environment, context });
  },
);
