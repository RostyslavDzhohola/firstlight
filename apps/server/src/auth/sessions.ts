// One live session per character (SPEC §5.4.3): a new join kicks the old one.
//
// Rooms call `register` in onJoin and kick the returned previous session (it may be in another room),
// and `unregister` in onLeave. The registry is process-wide (one server process).

export interface LiveSession {
  userId: string;
  roomId: string;
  sessionId: string;
  since: number;
}

export class SessionRegistry {
  private byUser = new Map<string, LiveSession>();

  /** Record the live session for `userId`; returns the previous one (to kick) if it was a different session. */
  register(userId: string, roomId: string, sessionId: string, now = Date.now()): LiveSession | null {
    const prev = this.byUser.get(userId) ?? null;
    this.byUser.set(userId, { userId, roomId, sessionId, since: now });
    if (prev && prev.sessionId === sessionId && prev.roomId === roomId) return null;
    return prev;
  }

  /** Forget the session if it is still the live one for `userId` (a kicked session leaving must not remove its replacement). */
  unregister(userId: string, sessionId: string): boolean {
    const cur = this.byUser.get(userId);
    if (!cur || cur.sessionId !== sessionId) return false;
    this.byUser.delete(userId);
    return true;
  }

  get(userId: string): LiveSession | null {
    return this.byUser.get(userId) ?? null;
  }

  isLive(userId: string, sessionId: string): boolean {
    return this.byUser.get(userId)?.sessionId === sessionId;
  }

  /**
   * A guest saved (their user id changed). Moves the guest's live session to the new id. If the
   * target account already had a live session (playing in another browser), that one is returned as
   * `displaced`: kick it, the newest session wins.
   */
  rekey(fromUserId: string, toUserId: string): { moved: LiveSession | null; displaced: LiveSession | null } {
    if (fromUserId === toUserId) return { moved: this.byUser.get(toUserId) ?? null, displaced: null };
    const cur = this.byUser.get(fromUserId) ?? null;
    if (!cur) return { moved: null, displaced: null };
    const displaced = this.byUser.get(toUserId) ?? null;
    this.byUser.delete(fromUserId);
    const moved = { ...cur, userId: toUserId };
    this.byUser.set(toUserId, moved);
    return { moved, displaced };
  }

  get size(): number {
    return this.byUser.size;
  }

  clear(): void {
    this.byUser.clear();
  }
}

/** The process-wide registry rooms use. */
export const liveSessions = new SessionRegistry();
