import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

export const record = internalMutation({
  args: { sourceCommitSha: v.string(), environment: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("deploys", args);
    return null;
  },
});

export const latest = query({
  args: {},
  returns: v.union(v.null(), v.object({ sourceCommitSha: v.string(), environment: v.string(), greeting: v.string() })),
  handler: async (ctx) => {
    const deploy = await ctx.db.query("deploys").order("desc").first();
    if (deploy === null) return null;
    return { sourceCommitSha: deploy.sourceCommitSha, environment: deploy.environment, greeting: process.env.GREETING ?? "" };
  },
});
