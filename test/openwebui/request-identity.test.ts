import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  createSignedOpenWebUiIdentityResolver,
  openWebUiHeaderIdentityResolver,
} from "../../src/openwebui/request-identity.ts";

const SECRET = "test-forwarded-identity-jwt-secret";
const NOW = 1_800_000_000;

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(
  claims: Readonly<Record<string, unknown>> = {},
  header: Readonly<Record<string, unknown>> = { alg: "HS256", typ: "JWT" },
  algorithm = "sha256",
  secret = SECRET,
): string {
  const signingInput = `${encode(header)}.${encode({
    iss: "open-webui",
    sub: "fictional-user",
    iat: NOW - 1,
    exp: NOW + 60,
    ...claims,
  })}`;
  const signature = createHmac(algorithm, secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

function request(
  identityToken: string | undefined,
  chatId = "fictional-chat",
  extraHeaders: Readonly<Record<string, string>> = {},
): Request {
  const headers = new Headers(extraHeaders);
  if (identityToken !== undefined) headers.set("x-openwebui-user-jwt", identityToken);
  headers.set("x-openwebui-chat-id", chatId);
  return new Request("http://localhost/v1/chat/completions", { headers });
}

function signedResolver() {
  return createSignedOpenWebUiIdentityResolver({
    secret: SECRET,
    nowSeconds: () => NOW,
  });
}

describe("Open WebUI request identity", () => {
  test("supports the explicit legacy header adapter", () => {
    const valid = request(undefined, " fictional-chat ", {
      "x-openwebui-user-id": " fictional-user ",
    });
    expect(openWebUiHeaderIdentityResolver(valid)).toEqual({
      userId: "fictional-user",
      chatId: "fictional-chat",
    });
    expect(openWebUiHeaderIdentityResolver(request(undefined))).toBeUndefined();
    expect(
      openWebUiHeaderIdentityResolver(
        request(undefined, " ", {
          "x-openwebui-user-id": "fictional-user",
        }),
      ),
    ).toBeUndefined();
  });

  test("accepts a signed subject and explicit chat id at the time boundary", () => {
    const resolver = signedResolver();
    expect(resolver(request(token()))).toEqual({
      userId: "fictional-user",
      chatId: "fictional-chat",
    });
  });

  test("ignores unsigned Open WebUI identity fields", () => {
    const resolver = signedResolver();
    expect(
      resolver(
        request(token({ sub: "signed-user" }), "fictional-chat", {
          "x-openwebui-user-id": "spoofed-user",
          "x-openwebui-user-email": "spoofed@example.test",
          "x-openwebui-user-name": "Spoofed User",
          "x-openwebui-user-role": "admin",
        }),
      ),
    ).toEqual({ userId: "signed-user", chatId: "fictional-chat" });
    expect(
      resolver(
        request(undefined, "fictional-chat", {
          "x-openwebui-user-id": "unsigned-user",
        }),
      ),
    ).toBeUndefined();
  });

  test("rejects empty secrets and algorithm confusion", () => {
    expect(() => createSignedOpenWebUiIdentityResolver({ secret: " " })).toThrow(
      "JWT secret must not be empty",
    );
    const resolver = signedResolver();
    for (const candidate of [
      token({}, { alg: "none", typ: "JWT" }),
      token({}, { alg: "HS384", typ: "JWT" }, "sha384"),
      token({}, { alg: "RS256", typ: "JWT" }),
    ]) {
      expect(resolver(request(candidate))).toBeUndefined();
    }
  });

  test("rejects malformed compact serialization and JSON records", () => {
    const resolver = signedResolver();
    const signature = Buffer.alloc(32).toString("base64url");
    for (const candidate of [
      "not-a-jwt",
      "a..b",
      "a.b.c.d",
      `***.${encode({})}.${signature}`,
      `${encode([])}.${encode({})}.${signature}`,
      `${encode({ alg: "HS256" })}.${encode([])}.${signature}`,
      `${encode({ alg: "HS256" })}.e2JhZA.${signature}`,
    ]) {
      expect(resolver(request(candidate))).toBeUndefined();
    }
  });

  test("requires the issuer, subject, chat id, and ordered integer times", () => {
    const resolver = signedResolver();
    for (const claims of [
      { iss: "other" },
      { iss: undefined },
      { sub: undefined },
      { sub: 123 },
      { sub: " " },
      { iat: undefined },
      { iat: "1799999999" },
      { iat: NOW + 1 },
      { iat: -1 },
      { iat: NOW - 0.5 },
      { exp: undefined },
      { exp: `${NOW + 60}` },
      { exp: NOW },
      { exp: NOW + 0.5 },
      { iat: NOW - 1, exp: NOW - 1 },
    ]) {
      expect(resolver(request(token(claims)))).toBeUndefined();
    }
    expect(resolver(request(token(), " "))).toBeUndefined();
  });

  test("rejects tampering, wrong keys, and wrong-length signatures", () => {
    const resolver = signedResolver();
    const valid = token();
    const [header, payload] = valid.split(".");
    const tampered = `${header}.${encode({
      iss: "open-webui",
      sub: "other-user",
      iat: NOW - 1,
      exp: NOW + 60,
    })}.${valid.split(".")[2]}`;
    const shortSignature = `${header}.${payload}.${Buffer.alloc(31).toString("base64url")}`;

    expect(resolver(request(tampered))).toBeUndefined();
    expect(resolver(request(token({}, undefined, "sha256", "wrong-secret")))).toBeUndefined();
    expect(resolver(request(shortSignature))).toBeUndefined();
  });
});
