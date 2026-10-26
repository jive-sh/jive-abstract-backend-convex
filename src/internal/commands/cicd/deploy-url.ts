import { makeDeployCommand } from "../../common/command";
import { backendModules } from "../../modules";

export const deployUrl = makeDeployCommand(
  "deploy-url",
  "print the URL the environment is reached at, creating its Convex project and deployment if absent",
  function* ({ environment, context }) {
    const url = yield* (yield* backendModules.Backend).url({ environment, context });
    process.stdout.write(`${url}\n`);
  },
);
