import { expect, test } from "bun:test";
import { webcrypto } from "node:crypto";
import { generateVariables } from "./generated-values";

test("random bytes are base64 after the prefix, and differ each time", async () => {
  const spec = { type: "randomBytes", bytes: 32, prefix: "1:" } as const;
  const first = (await generateVariables("CONNECTION_KEY", spec)).get("CONNECTION_KEY")!;
  const second = (await generateVariables("CONNECTION_KEY", spec)).get("CONNECTION_KEY")!;
  expect(first.startsWith("1:")).toBe(true);
  expect(Buffer.from(first.slice(2), "base64")).toHaveLength(32);
  expect(first).not.toBe(second);
});

test("an ES256 pair's JWKS data URI verifies what its private key signs", async () => {
  const spec = { type: "es256KeyPair", publicJwksVariable: "JWT_JWKS" } as const;
  const variables = await generateVariables("JWT_PRIVATE_KEY", spec);
  const privateJwk = JSON.parse(variables.get("JWT_PRIVATE_KEY")!);
  const dataUri = variables.get("JWT_JWKS")!;
  expect(dataUri.startsWith("data:text/plain;charset=utf-8;base64,")).toBe(true);
  const jwks = JSON.parse(Buffer.from(dataUri.split(",")[1]!, "base64").toString());
  expect(jwks.keys[0].kid).toBe(privateJwk.kid);
  expect(jwks.keys[0].d).toBeUndefined();

  const algorithm = { name: "ECDSA", namedCurve: "P-256" } as const;
  const signingKey = await webcrypto.subtle.importKey("jwk", privateJwk, algorithm, false, ["sign"]);
  const verifyingKey = await webcrypto.subtle.importKey("jwk", jwks.keys[0], algorithm, false, ["verify"]);
  const message = new TextEncoder().encode("header.payload");
  const signature = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, message);
  expect(await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyingKey, signature, message)).toBe(true);
});
