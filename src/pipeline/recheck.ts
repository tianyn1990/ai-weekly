import type { ReportState } from "../core/types.js";
import { buildReportNode, publishOrWaitNode, reviewFinalNode, reviewOutlineNode } from "./nodes.js";

type ReportNode = (state: ReportState) => Promise<Partial<ReportState>>;

// 复检流程复用现有审核/发布节点，避免出现“run 和 recheck 两套规则不一致”。
export async function recheckPendingWeeklyReport(state: ReportState): Promise<ReportState> {
  if (state.mode !== "weekly") {
    throw new Error("仅 weekly 模式支持 pending 复检发布");
  }

  return applyNodesSequentially(state, [reviewOutlineNode, reviewFinalNode, publishOrWaitNode, buildReportNode]);
}

async function applyNodesSequentially(state: ReportState, nodes: ReportNode[]): Promise<ReportState> {
  let current = state;
  for (const node of nodes) {
    const partial = await node(current);
    current = { ...current, ...partial };
  }
  return current;
}

