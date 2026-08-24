import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestIdentityResolver } from "../openai/request-identity.ts";

const OPEN_WEBUI_ISSUER = "open-webui";
const USER_ID_HEADER = "x-openwebui-user-id";
const USER_JWT_HEADER = "x-openwebui-user-jwt";
const CHAT_ID_HEADER = "x-openwebui-chat-id";

type JwtRecord = Readonly<Record<string, unknown>>;

export const openWebUiHeaderIdentityResolver: RequestIdentityResolver = (request) => {
  const userId = request.headers.get(USER_ID_HEADER)?.trim();
  const chatId = request.headers.get(CHAT_ID_HEADER)?.trim();
  return userId && chatId ? { userId, chatId } : undefined;
};

export type SignedOpenWebUiIdentityOptions = Readonly<{
  secret: string;
  nowSeconds?: () => number;
}>;

export function createSignedOpenWebUiIdentityResolver(
  options: SignedOpenWebUiIdentityOptions,
): RequestIdentityResolver {
  if (!options.secret.trim()) throw new Error("Open WebUI JWT secret must not be empty");
  const secret = Buffer.from(options.secret);
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  return (request) => {
    const token = request.headers.get(USER_JWT_HEADER)?.trim();
    const chatId = request.headers.get(CHAT_ID_HEADER)?.trim();
    if (!token || !chatId) return undefined;
    const userId = forwardedSubject(token, secret, nowSeconds());
    return userId ? { userId, chatId } : undefined;
  };
}

function forwardedSubject(
  token: string,
  secret: Buffer,
  nowSeconds: number,
): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return undefined;

  const header = decodeRecord(parts[0]);
  if (header?.alg !== "HS256") return undefined;

  const receivedSignature = decodeBase64Url(parts[2]);
  const expectedSignature = createHmac("sha256", secret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest();
  if (
    !receivedSignature ||
    receivedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    return undefined;
  }

  const claims = decodeRecord(parts[1]);
  const subject = claims?.sub;
  const issuedAt = claims?.iat;
  const expiresAt = claims?.exp;
  if (
    claims?.iss !== OPEN_WEBUI_ISSUER ||
    typeof subject !== "string" ||
    !subject.trim() ||
    !isUnixSecond(issuedAt) ||
    !isUnixSecond(expiresAt) ||
    issuedAt > nowSeconds ||
    expiresAt <= nowSeconds ||
    expiresAt <= issuedAt
  ) {
    return undefined;
  }
  return subject;
}

function decodeRecord(segment: string | undefined): JwtRecord | undefined {
  const decoded = decodeBase64Url(segment);
  if (!decoded) return undefined;
  try {
    const value: unknown = JSON.parse(decoded.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return value as JwtRecord;
  } catch {
    return undefined;
  }
}

function decodeBase64Url(value: string | undefined): Buffer | undefined {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return undefined;
  }
}

function isUnixSecond(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
