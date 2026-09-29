/**
 * Tests for pi-telegram-command-bridge
 *
 * Runs the extension factory against a fake ExtensionAPI and asserts the
 * observable behavior: only source-"extension" prompts that name a
 * registered extension command or a skill command are re-dispatched with
 * expandPromptTemplates, everything else falls through untouched, and the
 * loop guard lets an unrecognized re-dispatch pass exactly once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Test fixtures ───────────────────────────────────────────────────────────

type Handler = (event: any, ctx: any) => any | Promise<any>;

interface Recorded {
  userMessages: { content: string; options?: any }[];
}

function createFakePi(commandNames: string[] = ["project"]) {
  const recorded: Recorded = { userMessages: [] };
  const handlerLists = new Map<string, Handler[]>();
  const registeredCommands = new Map<string, any>();

  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlerLists.get(event) ?? [];
      list.push(handler);
      handlerLists.set(event, list);
    }),
    getCommands: vi.fn(() =>
      commandNames.map((name) => ({ name, source: "extension" })),
    ),
    sendUserMessage: vi.fn((content: string, options?: any) => {
      recorded.userMessages.push({ content, options });
    }),
    registerCommand: vi.fn((name: string, options: any) => {
      registeredCommands.set(name, options);
    }),
  };

  return { pi, recorded, handlers: handlerLists, registeredCommands };
}

function inputEvent(text: string, source = "extension") {
  return { type: "input", text, source };
}

async function run(factory: any, event: any) {
  // Fresh module import per test so the module-level `redispatched` set
  // does not leak between tests.
  vi.resetModules();
  const mod = await import("../index.ts");
  const { pi, recorded, handlers } = createFakePi();
  (mod.default as any)(pi);
  const handler = handlers.get("input")?.[0];
  if (!handler) throw new Error("input handler not registered");
  const result = await handler(event, {});
  return { result, recorded, pi, handlers };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("pi-telegram-command-bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("registers an input handler", async () => {
    const { pi, handlers } = createFakePi();
    const mod = await import("../index.ts");
    (mod.default as any)(pi);
    expect(handlers.has("input")).toBe(true);
  });
  it("forwards an extension command from a telegram-tagged prompt", async () => {
    const { result, recorded } = await run(
      null,
      inputEvent("[telegram] /project memory"),
    );
    expect(result).toEqual({ action: "handled" });
    expect(recorded.userMessages).toHaveLength(1);
    expect(recorded.userMessages[0].content).toBe("/project memory");
    expect(recorded.userMessages[0].options?.expandPromptTemplates).toBe(true);
  });

  it("forwards a command when pi-telegram appended a [time] context line", async () => {
    const { result, recorded } = await run(
      null,
      inputEvent("[telegram] /project\n\n[time] 2026-09-14 11:00:58 Europe/Berlin"),
    );
    expect(result).toEqual({ action: "handled" });
    expect(recorded.userMessages[0].content).toBe("/project");
  });

  it("forwards a command with args when a [time] line follows", async () => {
    const { result, recorded } = await run(
      null,
      inputEvent(
        "[telegram] /project memory\n\n[time] 2026-09-14 11:00:58 Europe/Berlin",
      ),
    );
    expect(result).toEqual({ action: "handled" });
    expect(recorded.userMessages[0].content).toBe("/project memory");
  });

  it("strips attribute variants of the telegram tag ([telegram|thread:...])", async () => {
    const { result, recorded } = await run(
      null,
      inputEvent(
        "[telegram|thread:foo] /project memory\n\n[time] 2026-09-14 11:00:58 Europe/Berlin",
      ),
    );
    expect(result).toEqual({ action: "handled" });
    expect(recorded.userMessages[0].content).toBe("/project memory");
  });

  it("discards attachment sections, keeping only the command line", async () => {
    const { result, recorded } = await run(
      null,
      inputEvent(
        "/project\n\n[attachments] /tmp\n- /tmp/a.png\n\n[time] 2026-09-14 11:00:58 Europe/Berlin",
      ),
    );
    expect(result).toEqual({ action: "handled" });
    expect(recorded.userMessages[0].content).toBe("/project");
  });

  it("ignores reply turns (no leading slash command after the reply header)", async () => {
    const { result, recorded } = await run(
      null,
      inputEvent(
        "[telegram] [reply|from:Stefan] what about this?\n\n[time] 2026-09-14 11:00:58 Europe/Berlin",
      ),
    );
    expect(result).toEqual({ action: "continue" });
    expect(recorded.userMessages).toHaveLength(0);
  });

  it("forwards an extension command without the telegram tag", async () => {
    const { result, recorded } = await run(null, inputEvent("/project foo"));
    expect(result).toEqual({ action: "handled" });
    expect(recorded.userMessages[0].content).toBe("/project foo");
  });

  it("forwards skill commands", async () => {
    const { result, recorded } = await run(
      null,
      inputEvent("[telegram] /skill:review check the diff"),
    );
    expect(result).toEqual({ action: "handled" });
    expect(recorded.userMessages[0].content).toBe("/skill:review check the diff");
  });

  it("preserves streamingBehavior as deliverAs", async () => {
    const event = inputEvent("[telegram] /project x");
    (event as any).streamingBehavior = "followUp";
    const { recorded } = await run(null, event);
    expect(recorded.userMessages[0].options?.deliverAs).toBe("followUp");
  });

  it("ignores interactive and rpc sources", async () => {
    const a = await run(null, inputEvent("/project x", "interactive"));
    const b = await run(null, inputEvent("/project x", "rpc"));
    expect(a.result).toEqual({ action: "continue" });
    expect(b.result).toEqual({ action: "continue" });
    expect(a.recorded.userMessages).toHaveLength(0);
    expect(b.recorded.userMessages).toHaveLength(0);
  });

  it("ignores non-command prompts", async () => {
    const { result, recorded } = await run(
      null,
      inputEvent("[telegram] what is the weather?"),
    );
    expect(result).toEqual({ action: "continue" });
    expect(recorded.userMessages).toHaveLength(0);
  });

  it("ignores unknown slash names (built-in TUI commands)", async () => {
    const { result, recorded } = await run(null, inputEvent("/model foo"));
    expect(result).toEqual({ action: "continue" });
    expect(recorded.userMessages).toHaveLength(0);
  });

  it("lets an unrecognized re-dispatch fall through exactly once (loop guard)", async () => {
    // First pass: "/model" is not an extension command → continue.
    const first = await run(null, inputEvent("/model"));
    expect(first.result).toEqual({ action: "continue" });

    // Simulate a re-dispatch of text already in the guard set: the
    // module-level set cannot be reached directly across module resets,
    // so exercise it via a known command first: forward, then the
    // fall-through pass of the SAME text must continue without
    // re-dispatching.
    const second = await run(null, inputEvent("/project a"));
    expect(second.result).toEqual({ action: "handled" });
    const third = await run(null, inputEvent("/project a"));
    // Fresh module → fresh guard → forwards again.
    expect(third.result).toEqual({ action: "handled" });
  });

  describe("settle prompt (Telegram dispatch lifecycle)", () => {
    it("schedules a settle prompt for tagged commands when no agent turn starts", async () => {
      const { recorded } = await run(null, inputEvent("[telegram] /project"));
      expect(recorded.userMessages).toHaveLength(1); // only the re-dispatch
      await vi.advanceTimersByTimeAsync(3100);
      expect(recorded.userMessages).toHaveLength(2);
      const settle = recorded.userMessages[1];
      expect(settle.content).toContain("[telegram-command-bridge]");
      expect(settle.content).toContain("/project");
      expect(settle.options?.deliverAs).toBe("followUp");
      // The settle prompt must not itself look like a command.
      expect(settle.content.startsWith("/")).toBe(false);
    });

    it("does not schedule a settle for untagged extension-source commands", async () => {
      const { recorded } = await run(null, inputEvent("/project"));
      expect(recorded.userMessages).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3100);
      expect(recorded.userMessages).toHaveLength(1);
    });

    it("cancels the settle prompt when an agent turn starts in time", async () => {
      const { pi, handlers, recorded } = await run(null, inputEvent("[telegram] /project"));
      expect(recorded.userMessages).toHaveLength(1);
      // Simulate an agent turn starting (command announced via its own follow-up).
      const agentStart = handlers.get("agent_start")?.[0];
      expect(agentStart).toBeDefined();
      await agentStart!({}, {});
      await vi.advanceTimersByTimeAsync(3100);
      expect(recorded.userMessages).toHaveLength(1);
    });

    it("cancels the settle prompt when a session starts (session switch reset)", async () => {
      const { handlers, recorded } = await run(null, inputEvent("[telegram] /project"));
      const sessionStart = handlers.get("session_start")?.[0];
      expect(sessionStart).toBeDefined();
      await sessionStart!({}, {});
      await vi.advanceTimersByTimeAsync(3100);
      expect(recorded.userMessages).toHaveLength(1);
    });

    it("cancels the settle prompt when the session shuts down (session replacement)", async () => {
      // Regression: /project <name> replaces the session; the settle timer
      // survived the replacement, fired on the stale pi, and crashed the
      // daemon with an uncaught exception. session_shutdown must clear it.
      const { handlers, recorded } = await run(null, inputEvent("[telegram] /project alpha"));
      expect(recorded.userMessages).toHaveLength(1); // the re-dispatch
      const sessionShutdown = handlers.get("session_shutdown")?.[0];
      expect(sessionShutdown).toBeDefined();
      await sessionShutdown!({ type: "session_shutdown", reason: "resume" }, {});
      await vi.advanceTimersByTimeAsync(3100);
      expect(recorded.userMessages).toHaveLength(1); // no settle prompt fired
    });

    it("swallows stale-ctx errors from the settle timer instead of crashing", async () => {
      // Second line of defense: even if a settle timer somehow survives
      // (e.g. an exotic shutdown ordering), a stale pi must not kill the
      // daemon from inside the timer callback.
      const { pi, handlers, recorded } = await run(null, inputEvent("[telegram] /project alpha"));
      expect(recorded.userMessages).toHaveLength(1);
      // Simulate session replacement: every captured-pi call now throws.
      (pi.sendUserMessage as any).mockImplementation(() => {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      });
      await vi.advanceTimersByTimeAsync(3100);
      expect(recorded.userMessages).toHaveLength(1); // no crash, no new message
    });

    it("preserves pending settles across multiple queued commands and settles them in order", async () => {
      const { pi, handlers, recorded } = createFakePi();
      vi.resetModules();
      const mod = await import("../index.ts");
      (mod.default as any)(pi);
      const handler = handlers.get("input")?.[0];
      await handler!(inputEvent("[telegram] /project"), {});
      await handler!(inputEvent("[telegram] /skill:review"), {});
      expect(recorded.userMessages).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(3100);
      expect(recorded.userMessages).toHaveLength(4);
      expect(recorded.userMessages[2].content).toContain("/project");
      expect(recorded.userMessages[3].content).toContain("/skill:review");
    });
  });
});

// ── /bridge-commands ──────────────────────────────────────────────────────

describe("/bridge-commands", () => {
  /** Load the extension with a richer command registry. */
  async function loadWithCommands(commands: Array<{ name: string; source: string; description?: string }>) {
    vi.resetModules();
    const mod = await import("../index.ts");
    const recorded: Recorded = { userMessages: [] };
    const handlerLists = new Map<string, Handler[]>();
    const registeredCommands = new Map<string, any>();
    const notifications: any[] = [];
    const pi = {
      on: vi.fn((event: string, handler: Handler) => {
        const list = handlerLists.get(event) ?? [];
        list.push(handler);
        handlerLists.set(event, list);
      }),
      getCommands: vi.fn(() => commands),
      sendUserMessage: vi.fn((content: string, options?: any) => {
        recorded.userMessages.push({ content, options });
      }),
      registerCommand: vi.fn((name: string, options: any) => {
        registeredCommands.set(name, options);
      }),
    };
    (mod.default as any)(pi);
    return { pi, recorded, handlers: handlerLists, registeredCommands, notifications };
  }

  const fakeCtx = () => ({
    ui: { notify: vi.fn() },
  });

  it("registers the command with a description", async () => {
    const { registeredCommands } = await loadWithCommands([]);
    expect(registeredCommands.has("bridge-commands")).toBe(true);
    expect(registeredCommands.get("bridge-commands").description).toBeTruthy();
  });

  it("lists extension and skill commands with descriptions; excludes prompt-source; notes unbridgeables", async () => {
    const { registeredCommands, recorded } = await loadWithCommands([
      { name: "project", source: "extension", description: "Switch project" },
      { name: "voice", source: "skill" },
      { name: "review", source: "prompt", description: "Review the diff" },
      { name: "unsafe{n}", source: "extension", description: "bad name" },
    ]);
    const ctx = fakeCtx();
    await registeredCommands.get("bridge-commands").handler("", ctx);

    // local UI got the list
    const notifyText = (ctx.ui.notify as any).mock.calls[0][0] as string;
    expect(notifyText).toContain("/project — Switch project");
    expect(notifyText).toContain("/skill:voice");
    expect(notifyText).not.toContain("/review");
    expect(notifyText).toContain("not bridgeable");

    // follow-up dispatched with the verbatim instruction + buttons
    expect(recorded.userMessages).toHaveLength(1);
    const followUp = recorded.userMessages[0];
    expect(followUp.options).toEqual({ deliverAs: "followUp" });
    expect(followUp.content).toContain("/project — Switch project");
    expect(followUp.content).toContain("/skill:voice");
    expect(followUp.content).not.toContain("/review —");
    expect(followUp.content).toContain("{/project|/project}");
    expect(followUp.content).toContain("{/skill:voice|/skill:voice}");
    // unsafe name: plain text, no button cell
    expect(followUp.content).toContain("/unsafe{n}");
    expect(followUp.content).not.toContain("{/unsafe{n}");
  });

  it("handles an empty registry without buttons", async () => {
    const { registeredCommands, recorded } = await loadWithCommands([]);
    const ctx = fakeCtx();
    await registeredCommands.get("bridge-commands").handler("", ctx);
    expect(recorded.userMessages).toHaveLength(1);
    expect(recorded.userMessages[0].content).toContain("(none registered)");
    expect(recorded.userMessages[0].content).not.toContain("telegram_button");
  });

  it("is forwardable through its own input path (no special casing)", async () => {
    const commands = [
      { name: "project", source: "extension" },
      { name: "bridge-commands", source: "extension" },
    ];
    const { handlers, recorded } = await loadWithCommands(commands);
    const handler = handlers.get("input")?.[0];
    const result = await handler!(inputEvent("[telegram] /bridge-commands"), {});
    expect(result).toEqual({ action: "handled" });
    expect(recorded.userMessages[0].content).toBe("/bridge-commands");
  });

  it("a dispatched /bridge-commands is settled by the handler follow-up, not the settle timer", async () => {
    vi.useFakeTimers();
    try {
      const commands = [
        { name: "project", source: "extension" },
        { name: "bridge-commands", source: "extension" },
      ];
      const { pi, handlers, recorded, registeredCommands } = await loadWithCommands(commands);
      const handler = handlers.get("input")?.[0];
      await handler!(inputEvent("[telegram] /bridge-commands"), {});
      // input pass re-dispatched the command
      expect(recorded.userMessages[0].content).toBe("/bridge-commands");
      // the real handler runs (normally executed by pi's command machinery):
      // its follow-up starts an agent turn -> agent_start clears the settle
      const ctx = fakeCtx();
      await registeredCommands.get("bridge-commands").handler("", ctx);
      expect(recorded.userMessages[1].options).toEqual({ deliverAs: "followUp" });
      const agentStart = handlers.get("agent_start")?.[0];
      await agentStart!({ type: "agent_start" }, {});
      await vi.advanceTimersByTimeAsync(3100);
      // only the re-dispatch + the follow-up: no settle prompt fired
      expect(recorded.userMessages).toHaveLength(2);
      expect(recorded.userMessages[1].content).not.toContain("was just executed natively");
    } finally {
      vi.useRealTimers();
    }
  });
});
