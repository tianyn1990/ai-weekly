import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import type { EnqueueOperationJobInput } from "./types.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export interface SchedulerTickInput {
  nowIso: string;
  timezoneName: string;
  alreadyTriggered: Set<string>;
}

export interface ScheduledJobCandidate {
  markerKey: string;
  job: EnqueueOperationJobInput;
}

export function computeDueScheduledJobs(input: SchedulerTickInput): ScheduledJobCandidate[] {
  const now = dayjs(input.nowIso).tz(input.timezoneName);
  const today = now.format("YYYY-MM-DD");
  const due: ScheduledJobCandidate[] = [];

  // 日报默认每天 09:00 触发。若 daemon 晚启动，补偿逻辑会在当天补触发一次。
  if (isSameOrAfterClock(now, 9, 0, 0)) {
    pushIfNotTriggered(due, input.alreadyTriggered, {
      markerKey: `daily_run:${today}`,
      job: {
        jobType: "run_daily",
        payload: {
          mode: "daily",
          mock: false,
          reportDate: today,
        },
        dedupeKey: `daily_run:${today}`,
        source: "daemon_scheduler",
        maxRetries: 1,
      },
    });
  }

  if (now.day() === 1) {
    if (isSameOrAfterClock(now, 9, 0, 0)) {
      pushIfNotTriggered(due, input.alreadyTriggered, {
        markerKey: `weekly_run:${today}`,
        job: {
          jobType: "run_weekly",
          payload: {
            mode: "weekly",
            mock: false,
            reportDate: today,
          },
          dedupeKey: `weekly_run:${today}`,
          source: "daemon_scheduler",
          maxRetries: 1,
        },
      });
    }

    if (isSameOrAfterClock(now, 11, 30, 0)) {
      pushIfNotTriggered(due, input.alreadyTriggered, {
        markerKey: `weekly_reminder:${today}`,
        job: {
          jobType: "notify_weekly_reminder",
          payload: {
            generatedAt: now.toISOString(),
          },
          dedupeKey: `weekly_reminder:${today}`,
          source: "daemon_scheduler",
          maxRetries: 0,
        },
      });
    }

    if (isSameOrAfterClock(now, 12, 31, 0)) {
      pushIfNotTriggered(due, input.alreadyTriggered, {
        markerKey: `weekly_watchdog:${today}`,
        job: {
          jobType: "watchdog_weekly",
          payload: {
            dryRun: false,
            generatedAt: now.toISOString(),
          },
          dedupeKey: `weekly_watchdog:${today}`,
          source: "daemon_scheduler",
          maxRetries: 0,
        },
      });
    }
  }

  return due;
}

function pushIfNotTriggered(target: ScheduledJobCandidate[], markers: Set<string>, candidate: ScheduledJobCandidate) {
  if (markers.has(candidate.markerKey)) {
    return;
  }
  target.push(candidate);
}

function isSameOrAfterClock(time: dayjs.Dayjs, hour: number, minute: number, second: number): boolean {
  const threshold = time.hour(hour).minute(minute).second(second).millisecond(0);
  return time.isSame(threshold) || time.isAfter(threshold);
}

export const __test__ = {
  isSameOrAfterClock,
};
