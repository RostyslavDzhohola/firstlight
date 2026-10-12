// Admin console `sky …` (staging): turns the words after `sky` into the server's sky command args
// (apps/server/src/world/SkySystem.ts). Both the weather and the time of day last `for <min>`
// (server default 15); `reset` goes back to the live schedule.
//   sky storm · sky rain 0.6 for 30 · sky time 0.83 hold · sky time 19:30 · sky reset

import { isWeather } from "@firstlight/shared";

export const SKY_HELP = "sky [weather] [0-1] [time 0-1|hh:mm] [hold] [for <min>] · sky reset";

/** Time of day 0..1 from "0.83" or "19:30" (the F3 overlay's clock), else undefined. */
function timeOfDay(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const clock = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (clock) {
    const h = Number(clock[1]), m = Number(clock[2]);
    return h < 24 && m < 60 ? (h * 60 + m) / 1440 : undefined;
  }
  const t = Number(s);
  return s.trim() !== "" && Number.isFinite(t) && t >= 0 && t <= 1 ? t : undefined;
}

export function parseSkyArgs(words: readonly string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.toLowerCase();
    if (w === "reset") args.clear = true;
    else if (w === "hold") args.hold = true;
    else if (isWeather(w)) args.weather = w;
    else if (w === "time") {
      const t = timeOfDay(words[i + 1]);
      if (t !== undefined) {
        args.dayT = t;
        i++;
      }
    } else if (w === "for") {
      const m = Number(words[i + 1]);
      if (words[i + 1] !== undefined && Number.isFinite(m) && m > 0) {
        args.minutes = m;
        i++;
      }
    } else {
      const v = Number(w);
      if (w !== "" && Number.isFinite(v) && v >= 0 && v <= 1) args.intensity = v;
    }
  }
  return args;
}
