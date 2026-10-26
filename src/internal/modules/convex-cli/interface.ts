import type { Redacted } from "effect";
import type { EffectGen } from "effective-modules";

/** The `convex` CLI and TypeScript, run over the package's own `convex/` directory with its own installed versions. */
export interface IConvexCli {
  /** Typechecks the Convex functions as `convex deploy` will, without a deployment. */
  typecheckFunctions(): EffectGen<void, string>;
  /** Pushes `convex/` to the deployment the key names; this also regenerates `convex/_generated`. */
  deploy(input: { readonly deployKey: Redacted.Redacted<string>; readonly message: string }): EffectGen<void, string>;
  /** Runs one function on the deployment the key names. */
  run(input: {
    readonly deployKey: Redacted.Redacted<string>;
    readonly functionName: string;
    readonly args: Record<string, string>;
  }): EffectGen<void, string>;
}
