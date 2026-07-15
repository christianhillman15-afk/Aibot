import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Anthropic-defined client-side tools: bash + text editor.
// The model emits tool_use blocks for these; we execute them here and return
// tool_result content. Both are schema-less on the API side — we only declare
// {type, name} and the model already knows the input shape.
// ---------------------------------------------------------------------------

export const BASH_TOOL = { type: "bash_20250124", name: "bash" };
export const EDITOR_TOOL = {
  type: "text_editor_20250728",
  name: "str_replace_based_edit_tool",
};

// Env for child processes: never leak API credentials to commands the model runs.
function childEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.AUTH_TOKEN;
  return env;
}

export function runBash(input, signal) {
  if (input && input.restart === true) {
    return Promise.resolve("Shell session restarted (fresh shell, cwd reset to workspace root).");
  }
  const command = input?.command;
  if (!command || typeof command !== "string") {
    const err = new Error("bash tool requires a 'command' string (or {restart: true}).");
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    execFile(
      "bash",
      ["-c", command],
      {
        cwd: config.workspaceDir,
        env: childEnv(),
        timeout: config.bashTimeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        killSignal: "SIGKILL",
        // Kill the command if the client disconnects mid-turn, so a stalled
        // command can't hold the conversation's busy-lock for the full timeout.
        signal,
      },
      (error, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join("\n");
        if (error && (error.name === "AbortError" || error.code === "ABORT_ERR")) {
          resolve(`Command aborted (client disconnected).\n${out}`);
        } else if (error && error.killed) {
          resolve(`Command timed out after ${config.bashTimeoutMs / 1000}s and was killed.\n${out}`);
        } else if (error && typeof error.code === "number") {
          // Non-zero exit is a normal result the model should see, not a tool error.
          resolve(`(exit code ${error.code})\n${out}`);
        } else if (error) {
          reject(new Error(`${error.message}\n${out}`));
        } else {
          resolve(out || "(no output)");
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Text editor tool — confined to the workspace directory.
// ---------------------------------------------------------------------------

function resolveInWorkspace(p) {
  if (!p || typeof p !== "string") throw new Error("Missing 'path'.");
  const ws = config.workspaceDir;
  // Accept absolute paths under the workspace, or paths relative to it.
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(ws, p);
  const rel = path.relative(ws, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Path is outside the workspace (${ws}). The editor tool only operates inside the workspace; use bash for anything else.`
    );
  }
  // Reject paths that traverse through a symlink escaping the workspace.
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch {
    try {
      real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      real = abs; // parent doesn't exist yet; creation will make it under ws
    }
  }
  const relReal = path.relative(fs.realpathSync(ws), real);
  if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
    throw new Error(`Path resolves outside the workspace via a symlink.`);
  }
  return abs;
}

function numberedLines(text, start = 1) {
  return text
    .split("\n")
    .map((line, i) => `${String(i + start).padStart(6)}\t${line}`)
    .join("\n");
}

export async function runEditor(input) {
  const command = input?.command;
  const abs = resolveInWorkspace(input?.path);

  switch (command) {
    case "view": {
      const stat = fs.statSync(abs, { throwIfNoEntry: false });
      if (!stat) throw new Error(`No such file or directory: ${input.path}`);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(abs, { withFileTypes: true });
        return (
          entries
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .sort()
            .join("\n") || "(empty directory)"
        );
      }
      const text = fs.readFileSync(abs, "utf8");
      if (Array.isArray(input.view_range) && input.view_range.length === 2) {
        const [from, to] = input.view_range;
        const lines = text.split("\n");
        const end = to === -1 ? lines.length : to;
        const slice = lines.slice(Math.max(0, from - 1), end).join("\n");
        return numberedLines(slice, Math.max(1, from));
      }
      return numberedLines(text);
    }

    case "create": {
      if (typeof input.file_text !== "string") throw new Error("'create' requires 'file_text'.");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (fs.existsSync(abs)) {
        fs.copyFileSync(abs, `${abs}.bak`);
      }
      fs.writeFileSync(abs, input.file_text, "utf8");
      return `File created: ${input.path}`;
    }

    case "str_replace": {
      const { old_str, new_str } = input;
      if (typeof old_str !== "string") throw new Error("'str_replace' requires 'old_str'.");
      const text = fs.readFileSync(abs, "utf8");
      const count = text.split(old_str).length - 1;
      if (count === 0) throw new Error("old_str not found in file — no changes made.");
      if (count > 1) throw new Error(`old_str matches ${count} locations — provide a more specific string.`);
      // split/join replaces the single match literally. Do NOT use
      // String.replace(old_str, new_str): a string replacement expands $$, $&,
      // $`, $' patterns, silently corrupting content that contains them
      // (common in shell scripts, Makefiles, LaTeX).
      fs.writeFileSync(abs, text.split(old_str).join(new_str ?? ""), "utf8");
      return `Edited ${input.path}: replaced 1 occurrence.`;
    }

    case "insert": {
      const { insert_line, insert_text } = input;
      if (typeof insert_text !== "string" || !Number.isInteger(insert_line)) {
        throw new Error("'insert' requires integer 'insert_line' and string 'insert_text'.");
      }
      const lines = fs.readFileSync(abs, "utf8").split("\n");
      if (insert_line < 0 || insert_line > lines.length) {
        throw new Error(`insert_line out of range (file has ${lines.length} lines).`);
      }
      lines.splice(insert_line, 0, ...insert_text.split("\n"));
      fs.writeFileSync(abs, lines.join("\n"), "utf8");
      return `Inserted text after line ${insert_line} in ${input.path}.`;
    }

    default:
      throw new Error(`Unsupported editor command: ${command}`);
  }
}
