import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export function nowInTimezoneIso(timezoneName: string): string {
  return dayjs().tz(timezoneName).toISOString();
}

export function computeWeeklyReviewDeadline(nowIso: string, timezoneName: string): string {
  const now = dayjs(nowIso).tz(timezoneName);
  let deadline = now.day(1).hour(12).minute(30).second(0).millisecond(0);

  // 若当前时间已经超过本周一截止点，则滚动到下周一。
  if (now.isAfter(deadline)) {
    deadline = deadline.add(7, "day");
  }

  return deadline.toISOString();
}

export function formatHumanTime(iso: string, timezoneName: string): string {
  return dayjs(iso).tz(timezoneName).format("YYYY-MM-DD HH:mm");
}
