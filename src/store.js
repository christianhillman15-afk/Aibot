import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

const dir = () => path.join(config.dataDir, "conversations");

function fileFor(id) {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("Invalid conversation id");
  return path.join(dir(), `${id}.json`);
}

export function createConversation({ mode = "standard", title = "New chat" } = {}) {
  const id = crypto.randomBytes(8).toString("hex");
  const conv = {
    id,
    title,
    mode,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
  saveConversation(conv);
  return conv;
}

export function loadConversation(id) {
  const f = fileFor(id);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

export function saveConversation(conv) {
  conv.updatedAt = new Date().toISOString();
  const f = fileFor(conv.id);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(conv), "utf8");
  fs.renameSync(tmp, f);
}

export function deleteConversation(id) {
  const f = fileFor(id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

export function listConversations() {
  if (!fs.existsSync(dir())) return [];
  return fs
    .readdirSync(dir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(dir(), f), "utf8"));
        return {
          id: c.id,
          title: c.title,
          mode: c.mode,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          messageCount: c.messages.length,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
