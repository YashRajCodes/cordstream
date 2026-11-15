import { production, sessionLifetime } from "./config";
import type { Session } from "./types";

export const sessions = new Map<string, Session>();
export const oauthStates = new Map<string, number>();

export function cookieValue(cookieHeader: string | undefined, name: string) {
  const value = cookieHeader?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return value?.slice(name.length + 1);
}

export function getSession(cookieHeader: string | undefined) {
  const id = cookieValue(cookieHeader, "cordstream_session");
  if (!id) return undefined;
  const session = sessions.get(id);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(id);
    return undefined;
  }
  return session;
}

export function sessionCookie(id: string) {
  const secure = production ? "; Secure" : "";
  return `cordstream_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionLifetime}${secure}`;
}

export function expiredSessionCookie() {
  const secure = production ? "; Secure" : "";
  return `cordstream_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
