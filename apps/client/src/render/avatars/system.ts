// Avatar client system: syncs each AvatarView with its PlayerState (starter, palette, held weapon,
// flags), turns combat messages into one-shot clips, and runs the distance LOD pass each frame.
// Registered through the CLIENT_SYSTEMS extension point (game/systems.ts).

import { WEAPONS } from "@firstlight/shared/content/weapons";
import { CLIENT_SYSTEMS, type ClientSystem } from "../../game/systems.ts";
import type { Game } from "../../game/Game.ts";
import { AvatarView, type OneShot } from "../Avatars.ts";

function avatarSystem(game: Game): ClientSystem | null {
  const room = game.net.room;
  if (!room) return null;
  const me = room.sessionId;
  const viewOf = (id: string): AvatarView | undefined => (id === me ? game.self : game.avatars.get(id));
  const offs: (() => void)[] = [];
  const on = (type: string, fn: (m: any) => void) => {
    const off = room.onMessage(type, fn) as unknown;
    if (typeof off === "function") offs.push(off as () => void);
  };
  const kindFor = (weapon: number, fallback: OneShot): OneShot => {
    const w = WEAPONS[weapon];
    if (!w) return fallback;
    if (w.delivery === "thrown" || w.id === "kunai") return "throw"; // kunai are thrown overhand
    if (w.cls === "magic" || w.delivery === "heal" || w.delivery === "bubble") return "cast";
    return fallback;
  };
  // Remote players' attacks are server-driven; the local avatar already played its one-shot when
  // CombatClient sent the input, so its own echo is ignored here.
  const remote = (id: string) => (id === me ? undefined : game.avatars.get(id));
  on("swing", (m: { by: string; weapon: number }) => remote(m.by)?.trigger("attack"));
  on("shot", (m: { by: string; weapon: number }) => remote(m.by)?.trigger(kindFor(m.weapon, "shoot")));
  on("projectile", (m: { by: string; weapon: number }) => remote(m.by)?.trigger(kindFor(m.weapon, "shoot")));
  on("hit", (m: { target: string; amount: number }) => viewOf(m.target)?.trigger(m.amount >= 30 ? "hit_heavy" : "hit"));

  return {
    update() {
      const players = (room.state as any)?.players;
      if (players) {
        const sync = (view: AvatarView | undefined, st: any) => {
          if (!view || !st) return;
          view.setLook(st.palette ?? 0, st.starter ?? 0, st.look ?? 0);
          view.setWeapon(st.weapon ?? 0);
          view.setFlags(st.flags ?? 0);
        };
        sync(game.self, players.get(me));
        for (const [id, view] of game.avatars) sync(view, players.get(id));
      }
      AvatarView.updateLod(game.ctx.camera, game.ctx.settings.fullAvatars, game.self);
    },
    dispose() {
      for (const off of offs) off();
    },
  };
}

if (!CLIENT_SYSTEMS.includes(avatarSystem)) CLIENT_SYSTEMS.push(avatarSystem);
