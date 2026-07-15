import { config } from "./config.js";
import { BASH_TOOL, EDITOR_TOOL, runBash, runEditor } from "./tools.js";
import { SPAWN_TOOL, spawnAgents } from "./ultra.js";

// ---------------------------------------------------------------------------
// Agentic loop for claude-fable-5.
//
// Fable 5 specifics honored here:
//  - No `thinking` budget config; adaptive thinking is always on. We pass
//    {type:"adaptive", display:"summarized"} so the UI can show reasoning summaries.
//  - Depth is controlled with output_config.effort (low..max).
//  - Safety classifiers can decline a request (stop_reason "refusal"). We opt
//    into server-side fallbacks so a decline is retried on claude-opus-4-8
//    within the same call (beta: server-side-fallback-2026-06-01).
//  - Thinking blocks are echoed back unchanged on multi-turn (required).
// ---------------------------------------------------------------------------

const SERVER_TOOLS = [
  { type: "web_search_20260209", name: "web_search", max_uses: 8 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 12 },
];

const BASE_SYSTEM = `You are a personal AI assistant running on your owner's private server. You are the only user-facing AI on this machine and you work only for your owner.

Environment:
- You have a persistent workspace directory for files. The text editor tool operates inside the workspace; give it paths relative to the workspace root (e.g. "notes/todo.md").
- The bash tool runs each command in a fresh shell whose working directory is the workspace root. Shell state (cd, variables) does NOT persist between commands, so use absolute paths or chain with && within one command.
- Files you create in the workspace persist across conversations.
- Use web_search and web_fetch for anything that benefits from current information.

Style:
- Lead with the outcome, then supporting detail. Be direct and concrete.
- For substantive work, verify results (run the code, re-read the file) before reporting success.`;

const ULTRA_SYSTEM_EXTRA = `

Ultra mode is enabled: you are an orchestrator with a spawn_agents tool. Delegate independent subtasks (research angles, separate files, parallel checks) to subagents rather than doing everything serially. Each subagent runs with its own fresh context and full bash/editor/web tools; its final message comes back to you as the tool result. Give each agent a complete, self-contained task description — they cannot see this conversation. Synthesize their reports yourself; you are responsible for the final answer.`;

export function systemPrompt(mode) {
  return mode === "ultra" ? BASE_SYSTEM + ULTRA_SYSTEM_EXTRA : BASE_SYSTEM;
}

function toolsFor(mode) {
  const tools = [...SERVER_TOOLS, BASH_TOOL, EDITOR_TOOL];
  if (mode === "ultra") tools.push(SPAWN_TOOL);
  return tools;
}

function buildParams({ system, tools, messages, effort, maxTokens }) {
  const params = {
    model: config.model,
    max_tokens: maxTokens,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort },
    // Cache the (frozen) system prompt, and auto-cache the growing conversation.
    cache_control: { type: "ephemeral" },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools,
    messages,
  };
  if (config.fallbacksEnabled && config.model === "claude-fable-5") {
    params.betas = ["server-side-fallback-2026-06-01"];
    params.fallbacks = [{ model: config.fallbackModel }];
  }
  return params;
}

function truncateResult(text) {
  const max = config.maxToolResultChars;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[... output truncated: ${text.length - max} characters omitted ...]`;
}

// After a mid-output refusal fallback, the API requires that thinking /
// tool_use blocks (and unpaired server_tool_use blocks) appearing BEFORE the
// final `fallback` block are not echoed back. Everything else echoes verbatim.
export function sanitizeAssistantContent(content) {
  const lastFallback = content.reduce((acc, b, i) => (b.type === "fallback" ? i : acc), -1);
  if (lastFallback < 0) return content;
  const resultIds = new Set(
    content.filter((b) => typeof b.tool_use_id === "string").map((b) => b.tool_use_id)
  );
  return content.filter((b, i) => {
    if (i >= lastFallback) return true;
    if (["thinking", "redacted_thinking", "tool_use"].includes(b.type)) return false;
    if (b.type === "server_tool_use" && !resultIds.has(b.id)) return false;
    return true;
  });
}

async function dispatchTool(toolUse, ctx) {
  switch (toolUse.name) {
    case "bash":
      return runBash(toolUse.input, ctx.signal);
    case "str_replace_based_edit_tool":
      return runEditor(toolUse.input);
    case "spawn_agents":
      return spawnAgents(toolUse.input, ctx);
    default:
      throw new Error(`Unknown tool: ${toolUse.name}`);
  }
}

function addUsage(totals, usage) {
  if (!usage) return;
  totals.input += usage.input_tokens || 0;
  totals.output += usage.output_tokens || 0;
  totals.cacheWrite += usage.cache_creation_input_tokens || 0;
  totals.cacheRead += usage.cache_read_input_tokens || 0;
}

/**
 * Run one user turn to completion (including all tool round-trips).
 * Mutates `messages` in place (appends assistant/tool-result turns).
 *
 * @param client   Anthropic client
 * @param opts.messages   full conversation history, ending with a user turn
 * @param opts.mode       "standard" | "ultra" | "subagent"
 * @param opts.effort     low | medium | high | xhigh | max
 * @param opts.emit       (event) => void   — streaming events for the UI
 * @param opts.isAborted  () => boolean
 */
export async function runAgentTurn(client, opts) {
  const { messages, mode, effort, emit, signal, isAborted = () => false } = opts;
  const system = opts.system || systemPrompt(mode);
  const tools = opts.tools || toolsFor(mode);
  const maxTokens = opts.maxTokens || config.maxTokens;
  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  let loops = 0;
  while (true) {
    if (isAborted()) break;
    if (++loops > config.maxToolLoops) {
      emit({ type: "notice", text: `Stopped after ${config.maxToolLoops} tool rounds (safety limit).` });
      break;
    }

    const stream = client.beta.messages.stream(
      buildParams({ system, tools, messages, effort, maxTokens })
    );

    try {
      for await (const event of stream) {
        if (isAborted()) {
          try { stream.abort(); } catch { /* already closed */ }
          break;
        }
        if (event.type === "content_block_start") {
          const b = event.content_block;
          if (b.type === "tool_use" || b.type === "server_tool_use") {
            emit({ type: "tool_start", name: b.name, server: b.type === "server_tool_use" });
          } else if (b.type === "thinking") {
            emit({ type: "thinking_start" });
          } else if (b.type === "fallback") {
            emit({
              type: "notice",
              text: `Safety classifier declined on ${b.from?.model || config.model}; continuing on ${b.to?.model || config.fallbackModel}.`,
            });
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            emit({ type: "text", text: event.delta.text });
          } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
            emit({ type: "thinking", text: event.delta.thinking });
          }
        }
      }
    } catch (err) {
      if (isAborted()) break;
      throw err;
    }
    if (isAborted()) break;

    const message = await stream.finalMessage();
    addUsage(usage, message.usage);

    // Build the assistant turn we will persist. When we are NOT about to
    // execute tools (any stop_reason other than "tool_use"), strip tool_use
    // blocks: a partial tool_use left behind by e.g. max_tokens would otherwise
    // be saved with no following tool_result and 400 every later request.
    let content = sanitizeAssistantContent(message.content);
    if (message.stop_reason !== "tool_use") {
      content = content.filter((b) => b.type !== "tool_use");
    }
    if (content.length > 0) {
      messages.push({ role: "assistant", content });
    } else if (message.stop_reason === "refusal") {
      // A refusal before any output yields an empty content array. Persist a
      // placeholder so the conversation stays valid — an empty assistant turn
      // would 400 on the next request and brick the conversation on disk.
      content = [{ type: "text", text: "[Request declined by the model's safety system.]" }];
      messages.push({ role: "assistant", content });
    }

    if (message.stop_reason === "pause_turn") {
      // Server-side tool loop paused; re-send to resume where it left off.
      continue;
    }

    if (message.stop_reason === "refusal") {
      const cat = message.stop_details?.category;
      emit({
        type: "refusal",
        category: cat ?? null,
        text: `The request was declined by the model's safety system${cat ? ` (category: ${cat})` : ""}. Try rephrasing.`,
      });
      break;
    }

    if (message.stop_reason === "max_tokens") {
      emit({ type: "notice", text: "Response hit the output token limit and may be incomplete. Send another message to continue." });
      break;
    }

    if (message.stop_reason === "model_context_window_exceeded") {
      emit({ type: "notice", text: "This conversation has outgrown the model's context window. Start a new chat to keep going." });
      break;
    }

    if (message.stop_reason !== "tool_use") break; // end_turn etc.

    // Derive tool calls from the content we actually persisted (post-sanitization),
    // so we never return a tool_result for a tool_use block that was stripped.
    const toolUses = content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) break;

    // Execute all requested tools in parallel; return every result in ONE user message.
    const results = await Promise.all(
      toolUses.map(async (tu) => {
        try {
          const out = await dispatchTool(tu, { client, emit, mode, isAborted, signal, usage });
          const text = truncateResult(String(out ?? ""));
          emit({ type: "tool_result", name: tu.name, ok: true, preview: text.slice(0, 300) });
          return { type: "tool_result", tool_use_id: tu.id, content: text };
        } catch (err) {
          const text = truncateResult(String(err?.message || err));
          emit({ type: "tool_result", name: tu.name, ok: false, preview: text.slice(0, 300) });
          return { type: "tool_result", tool_use_id: tu.id, content: text, is_error: true };
        }
      })
    );
    messages.push({ role: "user", content: results });
  }

  return { usage };
}
