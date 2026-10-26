import { webcrypto } from "node:crypto";
import type { GeneratedValue } from "../../public/manifest";

/** Every variable one `generateOnce` entry writes, keyed by name. */
export type GeneratedVariables = ReadonlyMap<string, string>;

/** The variables a `generateOnce` entry writes: its own, plus a key pair's public half. */
export function variablesWrittenBy(name: string, spec: GeneratedValue): ReadonlyArray<string> {
  return spec.type === "es256KeyPair" ? [name, spec.publicJwksVariable] : [name];
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** RFC 7638 thumbprint, used as the key id so a JWT's `kid` names exactly one key. */
async function jwkThumbprint(jwk: webcrypto.JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Buffer.from(digest).toString("base64url");
}

export async function generateVariables(name: string, spec: GeneratedValue): Promise<GeneratedVariables> {
  switch (spec.type) {
    case "randomBytes":
      return new Map([[name, `${spec.prefix}${base64(webcrypto.getRandomValues(new Uint8Array(spec.bytes)))}`]]);
    case "es256KeyPair": {
      const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const privateJwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
      const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
      const kid = await jwkThumbprint(publicJwk);
      const jwks = JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }] });
      return new Map([
        [name, JSON.stringify({ ...privateJwk, kid, alg: "ES256" })],
        // The data-URI form Convex documents for customJwt's `jwks`, so verification needs no endpoint.
        [spec.publicJwksVariable, `data:text/plain;charset=utf-8;base64,${Buffer.from(jwks).toString("base64")}`],
      ]);
    }
  }
}
