import { config } from "./config.js";
import { runAgentTurn } from "./agent.js";
import { BASH_TOOL, EDITOR_TOOL } from "./tools.js";

// ---------------------------------------------------------------------------
// Ultra mode: multi-agent orchestration.
// The orchestrator gets a spawn_agents tool; each spawned agent is an
// independent Fable 5 conversation with its own context and the full
// bash/editor/web tool set, run in parallel. The agent's final text is
// returned to the orchestrator as the tool result.
// ---------------------------------------------------------------------------

export const SPAWN_TOOL = {
  name: "spawn_agents",
  description:
    "Spawn parallel subagents for independent subtasks. Each agent runs in a fresh context with bash, file editor, web search, and web fetch tools, sharing the same workspace filesystem as you. Use it to fan out research angles, build separate components, or verify findings independently. Each task description must be fully self-contained — agents cannot see your conversation. Their final reports are returned to you; synthesize them yourself. Do not spawn agents for trivial single-step work.",
  input_schema: {
    type: "object",
    properties: {
      agents: {
        type: "array",
        description: `Subagents to run in parallel (max ${config.maxSubagents}).`,
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Short label for this agent, e.g. 'researcher-pricing'.",
            },
            task: {
              type: "string",
              description:
                "Complete, self-contained task description including all context the agent needs and what its final report must contain.",
            },
          },
          required: ["name", "task"],
        },
      },
    },
    required: ["agents"],
  },
};

const SUBAGENT_SYSTEM = `You are a subagent working for an orchestrator AI on its owner's private server. Complete the task you were given, then end with a final message that is a complete, self-contained report — it is the ONLY thing returned to the orchestrator, which cannot see your intermediate steps.

Environment:
- The bash tool runs each command in a fresh shell rooted at the shared workspace directory; shell state does not persist between commands.
- The text editor tool operates on paths inside the workspace.
- Use web_search / web_fetch for current information.

Be thorough but efficient; do not ask questions — make reasonable assumptions and state them in your report.`;

const SUBAGENT_TOOLS = [
  { type: "web_search_20260209", name: "web_search", max_uses: 8 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 12 },
  BASH_TOOL,
  EDITOR_TOOL,
];

function finalText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = m.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "(agent produced no text report)";
}

export async function spawnAgents(input, ctx) {
  const { emit, isAborted, client } = ctx;
  const list = input?.agents;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("spawn_agents requires a non-empty 'agents' array.");
  }
  if (list.length > config.maxSubagents) {
    throw new Error(`Too many agents: ${list.length} requested, max is ${config.maxSubagents}.`);
  }
  if (ctx.mode === "subagent") {
    throw new Error("Subagents cannot spawn further agents (one level of delegation only).");
  }

  const reports = await Promise.all(
    list.map(async ({ name, task }, i) => {
      const label = name || `agent-${i + 1}`;
      emit({ type: "agent_start", agent: label });
      const messages = [{ role: "user", content: [{ type: "text", text: task }] }];
      try {
        const { usage } = await runAgentTurn(client, {
          messages,
          mode: "subagent",
          effort: config.subagentEffort,
          maxTokens: config.subagentMaxTokens,
          system: SUBAGENT_SYSTEM,
          tools: SUBAGENT_TOOLS,
          isAborted,
          signal: ctx.signal,
          emit: (e) => {
            // Relay only coarse activity for subagents, tagged with the agent label.
            if (e.type === "tool_start") emit({ type: "agent_tool", agent: label, name: e.name });
            if (e.type === "refusal") emit({ type: "agent_notice", agent: label, text: e.text });
          },
        });
        // Roll subagent token usage up into the orchestrator's totals so the
        // cost readout reflects the whole fan-out, not just the orchestrator.
        if (ctx.usage) {
          ctx.usage.input += usage.input;
          ctx.usage.output += usage.output;
          ctx.usage.cacheWrite += usage.cacheWrite;
          ctx.usage.cacheRead += usage.cacheRead;
        }
        emit({ type: "agent_done", agent: label, ok: true, usage });
        return `## Agent: ${label}\n\n${finalText(messages)}`;
      } catch (err) {
        emit({ type: "agent_done", agent: label, ok: false });
        return `## Agent: ${label}\n\nFAILED: ${String(err?.message || err)}`;
      }
    })
  );

  return reports.join("\n\n---\n\n");
}
