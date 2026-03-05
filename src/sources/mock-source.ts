import dayjs from "dayjs";

import type { RawItem, ReportMode } from "../core/types.js";

const MOCK_TITLES = [
  "LangGraph 发布新的 multi-agent orchestration 指南",
  "OpenAI 发布最新 reasoning model 与 function calling 增强",
  "Anthropic 分享 Agent 安全防护实践",
  "GitHub 热门开源：高性能 RAG pipeline 模板",
  "Papers with Code：新一代代码生成 benchmark",
  "Hugging Face 推出轻量化 inference toolkit",
  "Google DeepMind 发布多模态研究进展",
  "LangChain 发布 long-term memory 教程",
  "InfoQ 专栏：企业落地 AI Agent 的工程化要点",
  "社区案例：前端团队如何接入 AI coding assistant",
  "Open-source eval framework 支持自定义指标",
  "新工具：可视化 prompt tracing 平台",
  "研究动态：tool-use agent 的鲁棒性评测",
  "Meta AI 论文解读：高效推理架构",
  "行业新闻：主流云厂商联合发布模型互操作规范",
  "教程：从零实现结构化输出与 JSON schema 校验",
  "工程实践：多模型路由的成本优化方案",
  "开源项目：支持浏览器端 embedding 的库",
  "最佳实践：如何构建可审计的 AI 周报系统",
  "研究综述：长期记忆对 Agent 的影响",
  "新产品：团队知识库智能检索助手",
  "评测：不同模型在 coding task 上的表现差异",
  "教程：如何做 prompt injection 防护",
  "行业动态：AI 开发工具并购事件跟踪",
  "开源工具：低代码 Agent workflow builder",
  "技术分享：LangGraph checkpoint 机制详解",
  "新方案：混合检索在企业问答中的效果",
  "产品更新：开发者平台新增 observability 面板",
  "研究快讯：多 Agent 协作的通信协议优化",
  "案例复盘：AI 应用灰度发布策略",
];

export function collectMockItems(mode: ReportMode, nowIso: string): RawItem[] {
  const base = dayjs(nowIso);
  const total = mode === "weekly" ? 30 : 18;

  return MOCK_TITLES.slice(0, total).map((title, index) => {
    const publishedAt = base.subtract(index * 3, "hour").toISOString();
    return {
      sourceId: index % 2 === 0 ? "langchain-blog" : "huggingface-blog",
      sourceName: index % 2 === 0 ? "LangChain Blog" : "Hugging Face Blog",
      title,
      link: `https://example.com/mock/${index + 1}`,
      contentSnippet: `${title}，聚焦工程实践与可落地方案。`,
      publishedAt,
    };
  });
}
