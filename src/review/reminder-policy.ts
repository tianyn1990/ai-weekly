import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import type { ReviewArtifact } from "../core/review-artifact.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export function isWeeklyReminderWindowReached(generatedAt: string, timezoneName: string): boolean {
  const now = dayjs(generatedAt).tz(timezoneName);
  const reminderTime = now.day(1).hour(11).minute(30).second(0).millisecond(0);
  return now.day() === 1 && (now.isSame(reminderTime) || now.isAfter(reminderTime));
}

export function shouldSendWeeklyReminderForArtifact(artifact: ReviewArtifact, generatedAt: string): boolean {
  if (artifact.mode !== "weekly") {
    return false;
  }
  if (artifact.reviewStatus !== "pending_review" || artifact.publishStatus !== "pending") {
    return false;
  }
  if (!artifact.reviewDeadlineAt) {
    return false;
  }

  return dayjs(generatedAt).isBefore(dayjs(artifact.reviewDeadlineAt));
}
