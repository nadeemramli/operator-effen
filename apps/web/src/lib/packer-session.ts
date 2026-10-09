import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Packer sessions on the shared packer sign-in. After operator_verify_staff_pin accepts a
 * packer's PIN, the server sets an HttpOnly cookie that unlocks that one profile for this
 * account and site. pack-own saves read the packer from this cookie, never from the request
 * body. The session slides with each save and ends after IDLE_MS without one, or when the
 * packer taps Done.
 */
export const PACKER_COOKIE = "operator-packer";
export const PACKER_IDLE_MS = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PackerSession = {
  workspaceId: string;
  userId: string;
  profileId: string;
  expiresAt: number;
};

// A key of its own, derived from the commit secret, so a session cookie can never be
// mistaken for a commit attestation.
const key = (secret: Buffer) =>
  createHmac("sha256", secret).update("operator-packer-session-v1").digest();
const sign = (secret: Buffer, body: string) =>
  createHmac("sha256", key(secret)).update(body, "utf8").digest("hex");

export function sealPackerSession(secret: Buffer, session: PackerSession) {
  const body = [
    "v1",
    session.workspaceId,
    session.userId,
    session.profileId,
    String(session.expiresAt),
  ].join(".");
  return body + "." + sign(secret, body);
}

/** The session in `value` when it is genuine, unexpired and belongs to this user and site. */
export function openPackerSession(
  secret: Buffer,
  value: string | undefined,
  expected: { userId: string; workspaceId: string },
  now = Date.now(),
): PackerSession | null {
  const parts = (value ?? "").split(".");
  if (parts.length !== 6 || parts[0] !== "v1") return null;
  const [, workspaceId, userId, profileId, exp, mac] = parts;
  const good = Buffer.from(sign(secret, parts.slice(0, 5).join(".")), "hex");
  const given = Buffer.from(/^[0-9a-f]{64}$/.test(mac) ? mac : "", "hex");
  if (given.length !== good.length || !timingSafeEqual(given, good)) return null;
  const expiresAt = Number(exp);
  if (
    ![workspaceId, userId, profileId].every((id) => UUID.test(id)) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + PACKER_IDLE_MS ||
    userId !== expected.userId ||
    workspaceId !== expected.workspaceId
  )
    return null;
  return { workspaceId, userId, profileId, expiresAt };
}

export const packerCookieOptions = (maxAgeMs: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/api",
  maxAge: Math.max(0, Math.floor(maxAgeMs / 1000)),
});
