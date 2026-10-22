import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import {
  runAcpProvider,
  type AcpStream,
  type AcpStreamMessage,
  type AcpTransformer,
  type AcpVendorUpdate,
} from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnectRequest,
  ProviderRegistration,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";

const DEFAULT_COMMAND: readonly [string, ...string[]] = ["dsh", "--profile", "acp"];
const TRANSCRIPT_DIR = join(homedir(), ".local", "state", "dsh-paseo", "transcripts");
const MAX_RECORDED_ITEMS = 2_000;
const MAX_RECORDED_TEXT = 40_000;
// Replay payloads are one JSON notification; keep tool outputs bounded so a long session's
// replay cannot balloon into a multi-megagram single message.
const MAX_REPLAY_STRING = 8_000;
const REPLAY_BATCH_SIZE = 50;
const REPLAY_METHOD = "_dsh.replay";

interface ResolvedLaunch {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

/** One chronological transcript entry; replay maps these onto Paseo timeline items. */
interface RecordedItem {
  id: string;
  kind: "user" | "assistant" | "reasoning" | "tool";
  text?: string;
  callId?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  failed?: boolean;
}

/**
 * DSH's ACP stream is recorded per native session and replayed into Paseo when the session is
 * reopened. Paseo clears its timeline on reopen and expects the provider to replay history
 * before the session is ready, but DSH's `session/resume` restores agent context without
 * replaying the transcript. The bridge records the live stream (including user prompts it
 * forwards) and injects recorded items as vendor notifications immediately before the reopen
 * response, which its replay transformer converts into ordinary timeline items.
 */
class TranscriptRecorder {
  private readonly items = new Map<string, RecordedItem[]>();
  private readonly byKey = new Map<string, RecordedItem>();
  private nextId = new Map<string, number>();
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  recordUserPrompt(nativeSessionId: string, prompt: unknown): void {
    const blocks = Array.isArray(prompt) ? prompt : [];
    const text = blocks
      .map((block) => {
        const record = block as { type?: string; text?: unknown };
        return record.type === "text" && typeof record.text === "string" ? record.text : "";
      })
      .filter((part) => part.length > 0)
      .join("\n");
    if (!text) return;
    this.push(nativeSessionId, { id: this.newId(nativeSessionId), kind: "user", text });
  }

  recordUpdate(nativeSessionId: string, update: unknown): void {
    const record = update as {
      sessionUpdate?: string;
      messageId?: unknown;
      toolCallId?: unknown;
      text?: unknown;
      content?: { type?: string; text?: unknown };
      name?: unknown;
      title?: unknown;
      status?: unknown;
      rawInput?: unknown;
      rawOutput?: unknown;
    };
    const kind = record.sessionUpdate;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const content = record.content;
      if (!content || content.type !== "text" || typeof content.text !== "string") return;
      const key = `${kind}:${typeof record.messageId === "string" ? record.messageId : "anon"}`;
      let item = this.byKey.get(this.keyFor(nativeSessionId, key));
      if (!item) {
        item = {
          id: this.newId(nativeSessionId),
          kind: kind === "agent_message_chunk" ? "assistant" : "reasoning",
          text: "",
        };
        this.byKey.set(this.keyFor(nativeSessionId, key), item);
        this.push(nativeSessionId, item);
      }
      const cap = MAX_RECORDED_TEXT - (item.text?.length ?? 0);
      if (cap > 0) item.text = `${item.text ?? ""}${content.text.slice(0, cap)}`;
      this.scheduleFlush(nativeSessionId);
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      if (typeof record.toolCallId !== "string") return;
      const key = `tool:${record.toolCallId}`;
      let item = this.byKey.get(this.keyFor(nativeSessionId, key));
      if (!item) {
        item = { id: this.newId(nativeSessionId), kind: "tool", callId: record.toolCallId };
        this.byKey.set(this.keyFor(nativeSessionId, key), item);
        this.push(nativeSessionId, item);
      }
      if (typeof record.name === "string") item.name = record.name;
      else if (typeof record.title === "string" && item.name === undefined) {
        item.name = record.title;
      }
      if (record.rawInput !== undefined) item.input = record.rawInput;
      if (record.rawOutput !== undefined) item.output = record.rawOutput;
      if (record.status === "failed") item.failed = true;
      if (kind === "tool_call") item.failed = false;
      this.scheduleFlush(nativeSessionId);
    }
  }

  snapshot(nativeSessionId: string): RecordedItem[] {
    let items = this.items.get(nativeSessionId);
    if (!items) {
      items = this.loadFromDisk(nativeSessionId);
      // Never cache a miss: a transcript can be created after this point (for example a
      // backfilled or reopened session), and a stale empty cache would hide it forever.
      if (items.length > 0) this.items.set(nativeSessionId, items);
    }
    return items.map((item) => ({ ...item }));
  }

  private keyFor(nativeSessionId: string, key: string): string {
    return `${nativeSessionId}\u0000${key}`;
  }

  private newId(nativeSessionId: string): string {
    const next = (this.nextId.get(nativeSessionId) ?? 0) + 1;
    this.nextId.set(nativeSessionId, next);
    return `dsh-replay-${next}`;
  }

  private push(nativeSessionId: string, item: RecordedItem): void {
    let items = this.items.get(nativeSessionId);
    if (!items) {
      items = this.loadFromDisk(nativeSessionId);
      this.items.set(nativeSessionId, items);
      // Recover the sequence counter so replay ids never collide across plugin restarts.
      for (const existing of items) {
        const match = /^dsh-replay-(\d+)$/.exec(existing.id);
        if (match) this.nextId.set(nativeSessionId, Math.max(this.nextId.get(nativeSessionId) ?? 0, Number(match[1])));
      }
    }
    items.push(item);
    if (items.length > MAX_RECORDED_ITEMS) items.shift();
    this.scheduleFlush(nativeSessionId);
  }

  private loadFromDisk(nativeSessionId: string): RecordedItem[] {
    try {
      const parsed = JSON.parse(readFileSync(this.pathFor(nativeSessionId), "utf8"));
      return Array.isArray(parsed) ? (parsed as RecordedItem[]) : [];
    } catch {
      return [];
    }
  }

  private scheduleFlush(nativeSessionId: string): void {
    if (this.flushTimers.has(nativeSessionId)) return;
    const timer = setTimeout(() => {
      this.flushTimers.delete(nativeSessionId);
      const items = this.items.get(nativeSessionId);
      if (!items) return;
      try {
        mkdirSync(TRANSCRIPT_DIR, { recursive: true });
        writeFileSync(this.pathFor(nativeSessionId), JSON.stringify(items));
      } catch {
        /* replay is best effort; disk failures must not break a live session */
      }
    }, 500);
    timer.unref?.();
    this.flushTimers.set(nativeSessionId, timer);
  }

  private pathFor(nativeSessionId: string): string {
    return join(TRANSCRIPT_DIR, `${nativeSessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  }
}

const recorder = new TranscriptRecorder();

function toReplayTimelineItem(item: RecordedItem): ProviderTimelineItem | null {
  switch (item.kind) {
    case "user":
      return { id: item.id, type: "user_message", text: item.text ?? "" };
    case "assistant":
      return { id: item.id, type: "assistant_message", text: item.text ?? "" };
    case "reasoning":
      return { id: item.id, type: "reasoning", text: item.text ?? "" };
    case "tool":
      return item.failed
        ? {
            id: item.id,
            type: "tool_call",
            callId: item.callId ?? item.id,
            name: item.name ?? "tool",
            detail: { type: "unknown", input: jsonValue(item.input), output: jsonValue(item.output) },
            status: "failed",
            error: jsonValue(item.output ?? item.name ?? "failed"),
          }
        : {
            id: item.id,
            type: "tool_call",
            callId: item.callId ?? item.id,
            name: item.name ?? "tool",
            detail: { type: "unknown", input: jsonValue(item.input), output: jsonValue(item.output) },
            status: "completed",
            error: null,
          };
    default:
      return null;
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Deep-convert an unknown value into a JSON-safe value accepted by the provider protocol. */
function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX_REPLAY_STRING ? `${value.slice(0, MAX_REPLAY_STRING)}…` : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry));
  if (typeof value === "object" && value !== undefined) {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = jsonValue(entry);
    }
    return result;
  }
  return null;
}

/** Converts bridge-injected `_dsh.replay` vendor notifications into timeline items. */
const replayTransformer: AcpTransformer = {
  notification(notification): AcpVendorUpdate[] | null {
    if (notification.method !== REPLAY_METHOD) return null;
    const params = notification.params as { items?: unknown } | null;
    if (!params || !Array.isArray(params.items)) return null;
    const updates: AcpVendorUpdate[] = [];
    for (const raw of params.items) {
      const item = toReplayTimelineItem(raw as RecordedItem);
      if (item) updates.push({ type: "timeline", item });
    }
    return updates;
  },
};

/**
 * Why this bridge exists: Paseo's ACP shim reopens provider sessions with `session/load` and only
 * advertises `session.persistence` when the agent declares the `loadSession` capability. DSH's ACP
 * server persists sessions and supports `session/resume` with identical parameters but does not
 * implement ACP's history-replay variant of `session/load`.
 *
 * - inbound (agent to Paseo): the initialize response gains `agentCapabilities.loadSession = {}`;
 * - outbound (Paseo to agent): a `session/load` request is re-sent as `session/resume`.
 *
 * Everything else (prompts, permissions, timeline, config options) flows through Paseo's own
 * runAcpProvider machinery untouched.
 */
function rewriteInbound(message: AcpStreamMessage): AcpStreamMessage {
  const result = (message as { result?: unknown }).result;
  if (result && typeof result === "object" && "agentCapabilities" in result) {
    const capabilities = (result as { agentCapabilities?: Record<string, unknown> })
      .agentCapabilities;
    if (capabilities && capabilities.loadSession === undefined) {
      capabilities.loadSession = {};
    }
  }
  return message;
}

function rewriteOutbound(message: AcpStreamMessage): AcpStreamMessage {
  if ((message as { method?: string }).method === "session/load") {
    return { ...message, method: "session/resume" } as AcpStreamMessage;
  }
  return message;
}

/**
 * DSH tags the reasoning and text blocks of one assistant message with the same `messageId`.
 * Paseo's shim keys streamed text by `messageId` across kinds (text = previous + chunk), so an
 * unmodified stream appends reasoning text onto the answer. Distinct ids per kind keep them as
 * two separate timeline items.
 */
function rewriteUpdateIds(message: AcpStreamMessage): AcpStreamMessage {
  if ((message as { method?: string }).method !== "session/update") return message;
  const params = (message as { params?: unknown }).params as
    | { update?: { sessionUpdate?: string; messageId?: unknown } }
    | undefined;
  const update = params?.update;
  if (!update || typeof update.messageId !== "string") return message;
  if (update.sessionUpdate === "agent_thought_chunk") {
    update.messageId = `${update.messageId}:thought`;
  } else if (update.sessionUpdate === "agent_message_chunk") {
    update.messageId = `${update.messageId}:text`;
  }
  return message;
}

/**
 * Paseo's ACP shim maps a failed tool update's `error` straight onto `rawOutput`
 * (connection.ts: `error: snapshot.output`). DSH reports interrupted or failed tools without an
 * output (e.g. a tool call cancelled mid-turn), so the shim stores `status: "failed"` with
 * `error: null` — an item Paseo's own timeline fetch schema rejects (`NonNullUnknownSchema`),
 * which breaks the whole history fetch with "could not refresh agent history". Giving the shim a
 * non-null output for failed updates keeps every stored item schema-valid.
 */
function sanitizeFailedToolUpdate(message: AcpStreamMessage): AcpStreamMessage {
  if ((message as { method?: string }).method !== "session/update") return message;
  const params = (message as { params?: unknown }).params as
    | { update?: Record<string, unknown> }
    | undefined;
  const update = params?.update;
  if (!update) return message;
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return message;
  }
  if (update.status !== "failed") return message;
  if (update.rawOutput !== null && update.rawOutput !== undefined) return message;
  const fallback =
    typeof update.title === "string" && update.title !== ""
      ? update.title
      : typeof update.name === "string" && update.name !== ""
        ? update.name
        : "Tool call failed";
  return {
    ...message,
    params: { ...params, update: { ...update, rawOutput: fallback } },
  } as AcpStreamMessage;
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  try {
    child.stdin.end();
  } catch {
    // Already closed.
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) terminateProcess(child);
  }, 10_000);
  child.once("close", () => clearTimeout(timer));
}

/** Spawn one `dsh --profile acp` child and expose it as an NDJSON JSON-RPC ACP stream. */
function createBridgeStream(launch: ResolvedLaunch): AcpStream {
  // stdio: "pipe" guarantees stdin/stdout/stderr are streams.
  const child = spawnProcess(launch.command, [...launch.args], {
    env: { ...launch.env },
    stdio: "pipe",
  }) as ChildProcessWithoutNullStreams;
  child.stderr.resume();

  const pendingLoadResponses = new Map<number, string>();

  let controller: ReadableStreamDefaultController<AcpStreamMessage> | undefined;
  let closed = false;
  let readableClosed = false;
  const queue: AcpStreamMessage[] = [];
  const push = (message: AcpStreamMessage): void => {
    if (controller && !closed && !readableClosed) {
      try {
        controller.enqueue(message);
      } catch {
        readableClosed = true;
        queue.push(message);
      }
    } else {
      queue.push(message);
    }
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    // The controller is already closed when the consumer canceled the stream.
    if (controller && !readableClosed) {
      try {
        controller.close();
      } catch {
        /* stream already closed */
      }
    }
  };

  let pendingLine = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pendingLine += chunk;
    for (;;) {
      const newline = pendingLine.indexOf("\n");
      if (newline < 0) break;
      const line = pendingLine.slice(0, newline).trim();
      pendingLine = pendingLine.slice(newline + 1);
      if (!line) continue;
      let message: AcpStreamMessage;
      try {
        message = JSON.parse(line) as AcpStreamMessage;
      } catch {
        continue;
      }
      const record = message as {
        id?: number;
        method?: string;
        params?: { sessionId?: unknown; update?: unknown };
        result?: unknown;
        error?: unknown;
      };
      if (record.method === "session/update" && record.params) {
        const notification = record.params;
        if (typeof notification.sessionId === "string" && notification.update) {
          recorder.recordUpdate(notification.sessionId, notification.update);
        }
      }
      if (record.id !== undefined && pendingLoadResponses.has(record.id)) {
        const nativeSessionId = pendingLoadResponses.get(record.id)!;
        pendingLoadResponses.delete(record.id);
        if (record.error === undefined && record.result !== undefined) {
          const items = recorder.snapshot(nativeSessionId);
          // Replay before the load response so the shim's open() path processes the items.
          // Sent in batches: one notification per session's whole history would serialize a
          // single multi-megagram JSON message on a busy session and stall the connection.
          for (let offset = 0; offset < items.length; offset += REPLAY_BATCH_SIZE) {
            push({
              jsonrpc: "2.0",
              method: REPLAY_METHOD,
              params: { sessionId: nativeSessionId, items: items.slice(offset, offset + REPLAY_BATCH_SIZE) },
            } as unknown as AcpStreamMessage);
          }
        }
      }
      message = rewriteUpdateIds(rewriteInbound(message));
      push(message);
    }
  });
  child.once("close", close);
  child.once("error", close);

  const readable = new ReadableStream<AcpStreamMessage>({
    start(readableController) {
      controller = readableController;
      for (const message of queue) {
        try {
          readableController.enqueue(message);
        } catch {
          readableClosed = true;
          break;
        }
      }
      queue.length = 0;
      if (closed) {
        try {
          readableController.close();
          readableClosed = true;
        } catch {
          /* stream already closed */
        }
      }
    },
    cancel() {
      readableClosed = true;
      stopChild(child);
    },
  });

  const writable = new WritableStream<AcpStreamMessage>({
    write(message) {
      const record = message as {
        id?: number | string;
        method?: string;
        params?: { sessionId?: unknown; prompt?: unknown };
      };
      if (record.method === "session/load" && typeof record.id === "number" && record.params) {
        if (typeof record.params.sessionId === "string") {
          pendingLoadResponses.set(record.id, record.params.sessionId);
        }
      }
      if (record.method === "session/prompt" && record.params) {
        if (typeof record.params.sessionId === "string") {
          recorder.recordUserPrompt(record.params.sessionId, record.params.prompt);
        }
      }
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.write(`${JSON.stringify(rewriteOutbound(message))}\n`);
    },
    close() {
      stopChild(child);
    },
    abort() {
      stopChild(child);
    },
  });

  return { readable, writable };
}

export function createDshProvider(): ProviderRegistration {
  return {
    id: "dsh",
    label: "DeepSeek Harness",
    description: "DeepSeek Harness agent, served over ACP by `dsh --profile acp`",
    icon: "icon.svg",
    command: DEFAULT_COMMAND,
    async connect(request: ProviderConnectRequest) {
      const launch: ResolvedLaunch = request.launch ?? {
        command: DEFAULT_COMMAND[0],
        args: DEFAULT_COMMAND.slice(1),
        env: process.env as Readonly<Record<string, string>>,
      };
      const adapter = runAcpProvider({
        id: "dsh",
        label: "DeepSeek Harness",
        description: "DeepSeek Harness agent, served over ACP by `dsh --profile acp`",
        icon: "icon.svg",
        connector: () => createBridgeStream(launch),
        transformers: [replayTransformer],
      });
      return adapter.connect(request);
    },
  };
}
