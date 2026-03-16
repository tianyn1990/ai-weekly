import type { OperationJobType } from "./types.js";

export interface BuildManualOperationDedupeKeyInput {
  operation: OperationJobType;
  reportDate: string;
}

export function buildManualOperationDedupeKey(input: BuildManualOperationDedupeKeyInput): string {
  // 手动触发去重按“业务动作 + reportDate”稳定建 key，避免同一次点击因回调结构差异被重复入队。
  return `manual_op:${input.operation}:${input.reportDate}`;
}

export function buildManualRestartOperationDedupeKey(input: BuildManualOperationDedupeKeyInput): string {
  // “中止并重启”同样使用稳定 key，避免用户连续点击导致重启任务无限膨胀。
  return `manual_restart:${input.operation}:${input.reportDate}`;
}
