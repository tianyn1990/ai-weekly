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

  // Tue-Sat 运行时默认指向“下周一”审核窗口，避免误判为本周已超时。
  if (now.day() > 1) {
    deadline = deadline.add(7, "day");
  }

  return deadline.toISOString();
}

export function formatHumanTime(iso: string, timezoneName: string): string {
  return dayjs(iso).tz(timezoneName).format("YYYY-MM-DD HH:mm");
}
