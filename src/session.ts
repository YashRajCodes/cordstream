import { oauthLifetime, production, sessionLifetime } from "./config";
import type { Session } from "./types";

export const sessions = new Map<string, Session>();

const maxOAuthStates = 10_000;

/** OAuth state entries are short-lived and bounded even when callbacks never arrive. */
class ExpiringOAuthStates extends Map<string, number> {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  override set(state: string, issuedAt: number) {
    this.delete(state);
    super.set(state, issuedAt);
    let timer!: ReturnType<typeof setTimeout>;
    const delay = Math.max(0, issuedAt + oauthLifetime - Date.now());
    timer = setTimeout(() => {
      if (this.timers.get(state) !== timer) return;
      this.timers.delete(state);
      if (super.get(state) === issuedAt) super.delete(state);
    }, delay);
    timer.unref?.();
    this.timers.set(state, timer);

    while (this.size > maxOAuthStates) {
      const oldest = this.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    return this;
  }

  override delete(state: string) {
    const timer = this.timers.get(state);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(state);
    }
    return super.delete(state);
  }

  override clear() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    super.clear();
  }
}

export const oauthStates = new ExpiringOAuthStates();

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
