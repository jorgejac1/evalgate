/**
 * greenlight agent message bus — v0.4
 *
 * Append-only NDJSON log at .greenlight/messages.ndjson.
 * One AgentMessage per line. Agents append to send; agents read to receive.
 * No delivery guarantees — this is a shared log, not a queue.
 * Zero runtime dependencies.
 */

import {
  appendFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { logDir } from "./log.js";
import type { AgentMessage, MessageKind } from "./types.js";

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

export function messagesPath(todoPath: string): string {
  return join(logDir(todoPath), "messages.ndjson");
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface SendMessageOptions {
  from: string;
  to: string;
  kind: MessageKind;
  payload?: unknown;
  contractId?: string;
  correlationId?: string;
}

export function sendMessage(
  todoPath: string,
  opts: SendMessageOptions
): AgentMessage {
  const msg: AgentMessage = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    from: opts.from,
    to: opts.to,
    kind: opts.kind,
    contractId: opts.contractId,
    payload: opts.payload ?? null,
    correlationId: opts.correlationId,
  };

  const dir = logDir(todoPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(messagesPath(todoPath), JSON.stringify(msg) + "\n", "utf8");
  return msg;
}

// ---------------------------------------------------------------------------
// Read + filter
// ---------------------------------------------------------------------------

export interface ListMessagesOptions {
  to?: string;         // filter by recipient (matches "*" broadcasts too)
  from?: string;
  kind?: MessageKind;
  contractId?: string;
  limit?: number;
}

export function listMessages(
  todoPath: string,
  opts: ListMessagesOptions = {}
): AgentMessage[] {
  const path = messagesPath(todoPath);
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter(Boolean);

  const messages: AgentMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as AgentMessage);
    } catch {
      // Skip malformed lines
    }
  }

  let filtered = messages;
  if (opts.to !== undefined) {
    filtered = filtered.filter((m) => m.to === opts.to || m.to === "*");
  }
  if (opts.from !== undefined) {
    filtered = filtered.filter((m) => m.from === opts.from);
  }
  if (opts.kind !== undefined) {
    filtered = filtered.filter((m) => m.kind === opts.kind);
  }
  if (opts.contractId !== undefined) {
    filtered = filtered.filter((m) => m.contractId === opts.contractId);
  }

  // Most recent first
  filtered.reverse();

  if (opts.limit !== undefined && opts.limit > 0) {
    filtered = filtered.slice(0, opts.limit);
  }

  return filtered;
}
