import { Effect, Redacted, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { implementing, type EffectGen } from "effective-modules";
import { backendModules } from "../index";
import type { IConvexCli } from "./interface";

/**
 * Runs a tool from the package's own node_modules. Its output goes to stderr: two hooks' stdout is parsed by
 * the pipeline, and a tool's progress must never land in it. CONVEX_DEPLOY_KEY reaches only this child.
 */
function tool(args: ReadonlyArray<string>, deployKey?: Redacted.Redacted<string>) {
  return ChildProcess.make("bunx", [...args], {
    extendEnv: true,
    env: deployKey === undefined ? {} : { CONVEX_DEPLOY_KEY: Redacted.value(deployKey) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
}

export class ConvexCliImpl extends implementing(backendModules.ConvexCli)
  .uses(ChildProcessSpawner.ChildProcessSpawner)
  implements IConvexCli {
  *typecheckFunctions(): EffectGen<void, string> {
    yield* this.runTool("typecheck the Convex functions", ["tsc", "--noEmit", "-p", "convex"]);
  }

  *deploy(input: { readonly deployKey: Redacted.Redacted<string>; readonly message: string }): EffectGen<void, string> {
    yield* this.runTool("push the Convex functions", ["convex", "deploy", "--yes", "--message", input.message], input.deployKey);
  }

  *run(input: {
    readonly deployKey: Redacted.Redacted<string>;
    readonly functionName: string;
    readonly args: Record<string, string>;
  }): EffectGen<void, string> {
    yield* this.runTool(`run ${input.functionName}`, ["convex", "run", input.functionName, JSON.stringify(input.args)], input.deployKey);
  }

  private *runTool(purpose: string, args: ReadonlyArray<string>, deployKey?: Redacted.Redacted<string>): EffectGen<void, string> {
    const spawner = this.getDependency(ChildProcessSpawner.ChildProcessSpawner);
    const exitCode = yield* pipe(
      Effect.scoped(Effect.gen(function* () {
        const handle = yield* spawner.spawn(tool(args, deployKey));
        const [code] = yield* Effect.all([
          handle.exitCode,
          Stream.runForEach(handle.stdout, (chunk) => Effect.sync(() => { process.stderr.write(chunk); })),
        ], { concurrency: 2 });
        return code;
      })),
      Effect.mapError((e) => `Could not ${purpose}: ${e.message}`),
    );
    if (exitCode !== 0) return yield* Effect.fail(`Could not ${purpose}: \`bunx ${args[0]}\` exited with code ${exitCode}`);
  }
}
