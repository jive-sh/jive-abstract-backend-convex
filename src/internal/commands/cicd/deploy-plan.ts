import { makeDeployPlanCommand } from "../../common/command";
import { backendModules } from "../../modules";

export const deployPlan = makeDeployPlanCommand(
  "deploy-plan",
  "plan a deploy to the URL the environment is reached at, creating its Convex project and deployment if absent",
  function* ({ environment, context }) {
    return { deploy: true, url: yield* (yield* backendModules.Backend).url({ environment, context }) } as const;
  },
);
