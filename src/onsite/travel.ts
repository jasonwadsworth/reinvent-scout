import { VENUES, type Venue } from "../catalog/venue.js";
import type { OnsitePreferences } from "./config.js";

// Conservative local assumptions, not AWS shuttle schedules or measured journey times.
export const WALKING_MINUTES: readonly (readonly number[])[] = [
  [10, 50, 55, 70, 45], [50, 10, 20, 30, 25], [55, 20, 10, 20, 25],
  [70, 30, 20, 10, 35], [45, 25, 25, 35, 10],
];
export interface TravelEstimate {
  from: Venue; to: Venue; mode: "walk" | "shuttle"; baseMinutes: number;
  waitMinutes: number; peakMinutes: number; totalMinutes: number; checkInMinutes: number;
  provenance: "default assumption" | "user override";
}
function inWindows(clock: string, windows: OnsitePreferences["peakWindows"]): boolean {
  return windows.some(w => w.start < w.end ? clock >= w.start && clock < w.end : clock >= w.start || clock < w.end);
}
export function estimateTravel(from: Venue, to: Venue, departure: number, timezone: string, prefs: OnsitePreferences): TravelEstimate {
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(departure);
  const peak = inWindows(clock, prefs.peakWindows);
  const walk = prefs.routes.find(route => route.from === from && route.to === to && route.mode === "walk");
  const peakMinutes = peak ? (walk?.peakBufferMinutes ?? prefs.peakBufferMinutes) : 0;
  const baseMinutes = walk?.minutes ?? WALKING_MINUTES[VENUES.indexOf(from)]?.[VENUES.indexOf(to)];
  if (baseMinutes === undefined) throw new Error("Unknown travel route");
  let result: TravelEstimate = { from, to, mode: "walk", baseMinutes, waitMinutes: 0, peakMinutes, totalMinutes: baseMinutes + peakMinutes, checkInMinutes: prefs.checkInMinutes, provenance: walk ? "user override" : "default assumption" };
  if (prefs.shuttleEnabled) {
    const shuttle = prefs.routes.find(route => route.from === from && route.to === to && route.mode === "shuttle");
    if (shuttle && inWindows(clock, shuttle.windows ?? prefs.shuttleWindows)) {
      const peakMinutes = peak ? (shuttle.peakBufferMinutes ?? prefs.peakBufferMinutes) : 0;
      const waitMinutes = shuttle.waitMinutes ?? 10;
      const totalMinutes = shuttle.minutes + waitMinutes + peakMinutes;
      if (totalMinutes < result.totalMinutes) result = { ...result, mode: "shuttle", baseMinutes: shuttle.minutes, waitMinutes, peakMinutes, totalMinutes, provenance: "user override" };
    }
  }
  return result;
}
