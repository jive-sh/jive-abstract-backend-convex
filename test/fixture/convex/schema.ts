import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  deploys: defineTable({ sourceCommitSha: v.string(), environment: v.string() }),
});
