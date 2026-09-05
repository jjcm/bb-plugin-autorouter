import { describe, expect, it } from "vitest";
import type { BbPluginApi, NewThreadRequest } from "@get-bb/plugin-sdk";
import { rankAutoModelOptions } from "./benchmarks.js";
import type { AutoModelCandidate, ReasoningLevel } from "./benchmarks.js";
import {
  fallbackSelection,
  filterExcludedAndDisallowed,
  isModelOverrideGrounded,
  leastClassifierPermissionMode,
  leastClassifierReasoning,
  matchModelOverride,
  parseDifficultyDecision,
  quotaRemainingByProvider,
  isRoutableProvider,
  difficultyBandSelection,
  bandMatchesDifficulty,
  taskTypeBandSelection,
  checkEscalation,
  consumeEscalation,
  escalationRoute,
} from "./router.js";
import { defaultAutorouterSettings } from "./settings.js";
import type { EscalationRule } from "./settings.js";

function candidate(
  providerId: string,
  modelId: string,
  reasoningLevels: ReasoningLevel[],
): AutoModelCandidate {
  return {
    providerId,
    permissionModes: ["accept-edits", "full"],
    supportsServiceTier: true,
    model: {
      id: modelId,
      model: modelId,
      displayName: modelId,
      description: "",
      supportedReasoningEfforts: reasoningLevels.map((reasoningEffort) => ({
        reasoningEffort,
        description: reasoningEffort,
      })),
      defaultReasoningEffort: reasoningLevels[0] ?? "medium",
      isDefault: false,
    },
  };
}

function fakeBb(storage: Map<string, unknown>): BbPluginApi {
  return {
    storage: {
      kv: {
        get: async (key: string) => storage.get(key),
        set: async (key: string, value: unknown) => {
          storage.set(key, value);
        },
      },
    },
  } as unknown as BbPluginApi;
}

describe("difficulty decision", () => {
  it("parses compact JSON and integer-only fallbacks", () => {
    expect(
      parseDifficultyDecision('{"difficulty":87,"modelOverride":"Fable 5"}'),
    ).toEqual({ difficulty: 87, modelOverride: "Fable 5", taskType: null });
    expect(parseDifficultyDecision("12")).toEqual({
      difficulty: 12,
      modelOverride: null,
      taskType: null,
    });
  });

  it("parses a multimodal task type from classifier JSON", () => {
    expect(
      parseDifficultyDecision('{"difficulty":20,"taskType":"vision"}'),
    ).toEqual({ difficulty: 20, modelOverride: null, taskType: "vision" });
  });

  it("uses Cursor's lowest launchable reasoning despite a none model row", () => {
    expect(
      leastClassifierReasoning(
        candidate("acp-cursor", "gpt-5.6-sol-medium", [
          "none",
          "low",
          "medium",
        ]),
      ),
    ).toBe("low");
  });
});

describe("routable providers", () => {
  it("includes the local agy-backed Antigravity provider without broadening to OmniRoute", () => {
    expect(isRoutableProvider("antigravity")).toBe(true);
    expect(isRoutableProvider("omniroute")).toBe(false);
  });

  // Regression test: router.ts and benchmarks.ts each used to hardcode their
  // own separate provider allowlist. Adding Antigravity to router.ts's copy
  // (the one isRoutableProvider reads) left it eligible for thread creation
  // but silently excluded from rankAutoModelOptions's *own* copy in
  // benchmarks.ts, so it was never actually selected outside total
  // benchmarked-provider exhaustion -- confirmed live against a running bb
  // instance (bb autorouter route), not just inferred from reading the code.
  // Both files now read the same ROUTABLE_PROVIDER_IDS from benchmarks.ts.
  it("is honored identically by rankAutoModelOptions, not just candidate discovery", () => {
    const antigravityOnly = [
      candidate("antigravity", "gemini-3.7-flash-high", ["medium"]),
    ];
    expect(
      rankAutoModelOptions({
        candidates: antigravityOnly,
        difficulty: 50,
        frugality: 50,
        quotaRemainingByProvider: new Map([["antigravity", 1]]),
      }),
    ).toEqual([]); // no CursorBench entry exists for it -- correctly unscored, not fabricated
  });

  it("still gets a real routed thread via fallbackSelection when it's the only eligible candidate", () => {
    // This is the actual condition under which Antigravity gets chosen in
    // practice: every benchmarked provider (Codex, Claude Code, Cursor) is
    // unavailable or quota-exhausted, so rankAutoModelOptions returns no
    // ranked option and resolveRoute falls through to fallbackSelection.
    const request = {
      providerId: "codex",
      model: "gpt-5.6-sol",
      permissionMode: "accept-edits",
    } as unknown as NewThreadRequest;
    const route = fallbackSelection(
      [candidate("antigravity", "gemini-3.7-flash-high", ["medium"])],
      request,
      50,
      50,
      false,
    );
    expect(route).toMatchObject({
      providerId: "antigravity",
      model: "gemini-3.7-flash-high",
      benchmarkScore: null,
    });
  });
});

describe("model overrides", () => {
  const candidates = [
    candidate("codex", "gpt-5.6-sol", ["medium", "high"]),
    candidate("acp-cursor", "claude-fable-5-thinking-medium", ["high", "max"]),
    candidate("acp-cursor", "composer-2.5", ["medium"]),
  ];

  it("matches exact provider/model and human-readable family names", () => {
    expect(matchModelOverride(candidates, "codex/gpt-5.6-sol")).toEqual([
      candidates[0],
    ]);
    expect(matchModelOverride(candidates, "Fable 5")).toEqual([candidates[1]]);
  });

  it("requires an available, grounded model", () => {
    const matched = matchModelOverride(candidates, "Composer 2.5");
    expect(
      isModelOverrideGrounded("Composer 2.5", matched, [
        "Use Composer 2.5 for this task",
        "",
      ]),
    ).toBe(true);
    expect(
      isModelOverrideGrounded("Composer 2.5", matched, [
        "Fix the button color",
        "",
      ]),
    ).toBe(false);
    expect(matchModelOverride(candidates, "best")).toEqual([]);
  });
});

describe("excluded models and allowed providers", () => {
  const candidates = [
    candidate("codex", "gpt-5.6-sol", ["medium"]),
    candidate("codex", "gpt-5.6-luna", ["medium"]),
    candidate("claude-code", "claude-fable-5", ["medium"]),
    candidate("antigravity", "gemini-3.7-flash-high", ["medium"]),
  ];
  const settings = (
    overrides: Partial<typeof defaultAutorouterSettings>,
  ) => ({ ...defaultAutorouterSettings, ...overrides });

  it("excludes every model from a bare provider entry", () => {
    expect(
      filterExcludedAndDisallowed(
        candidates,
        settings({ excludedModels: ["codex"] }),
      ),
    ).toEqual(candidates.slice(2));
  });

  it("excludes an exact provider/model pin without removing its siblings", () => {
    expect(
      filterExcludedAndDisallowed(
        candidates,
        settings({ excludedModels: ["codex/gpt-5.6-sol"] }),
      ),
    ).toEqual([candidates[1], candidates[2], candidates[3]]);
  });

  it("restricts candidates to the allowed provider subset", () => {
    expect(
      filterExcludedAndDisallowed(
        candidates,
        settings({ allowedProviders: ["codex", "antigravity"] }),
      ),
    ).toEqual([candidates[0], candidates[1], candidates[3]]);
  });

  it("leaves candidates unrestricted when the allowlist is empty", () => {
    expect(
      filterExcludedAndDisallowed(candidates, settings({ allowedProviders: [] })),
    ).toEqual(candidates);
  });

  it("applies exclusions before restricting to allowed providers", () => {
    expect(
      filterExcludedAndDisallowed(
        candidates,
        settings({
          allowedProviders: ["codex", "claude-code"],
          excludedModels: ["codex/gpt-5.6-sol"],
        }),
      ),
    ).toEqual([candidates[1], candidates[2]]);
  });
});

describe("provider quota", () => {
  it("uses Cursor on-demand quota after included usage is exhausted", () => {
    const remaining = quotaRemainingByProvider({
      codex: { status: "expired" },
      claudeCode: { status: "unauthenticated" },
      cursor: {
        status: "ok",
        accountEmail: null,
        planLabel: "Pro",
        windows: [
          { label: "Plan usage", usedPercent: 100, resetsAt: null },
          {
            label: "On-demand spend",
            usedPercent: 25,
            resetsAt: null,
            cost: { usedUsdCents: 2_500, limitUsdCents: 10_000 },
          },
        ],
      },
    });
    expect(remaining.get("codex")).toBe(0);
    expect(remaining.get("claude-code")).toBe(0);
    expect(remaining.get("acp-cursor")).toBe(0.75);
  });

  it("doesn't crash when sdk.system.usageLimits() omits a provider's entry entirely", () => {
    // Real regression: bb-core has been observed to omit a key from the
    // usageLimits response rather than report a typed error status for it,
    // which used to throw "Cannot read properties of undefined (reading
    // 'status')" and crash the whole route.
    const remaining = quotaRemainingByProvider({
      codex: undefined,
      claudeCode: { status: "unauthenticated" },
      cursor: { status: "ok", accountEmail: null, planLabel: "Pro", windows: [] },
    } as unknown as Parameters<typeof quotaRemainingByProvider>[0]);
    expect(remaining.get("codex")).toBe(1);
    expect(remaining.get("claude-code")).toBe(0);
    expect(remaining.get("acp-cursor")).toBe(1);
  });

  it("uses bb's current provider-id usage keys for quota exhaustion", () => {
    const remaining = quotaRemainingByProvider({
      codex: { status: "ok", accountEmail: null, planLabel: "Plus", windows: [{ label: "Session", usedPercent: 25, resetsAt: null }] },
      "claude-code": { status: "ok", accountEmail: null, planLabel: "Pro", windows: [{ label: "Session", usedPercent: 100, resetsAt: null }] },
      "acp-cursor": { status: "ok", accountEmail: null, planLabel: "Pro", windows: [{ label: "Session", usedPercent: 50, resetsAt: null }] },
    } as unknown as Parameters<typeof quotaRemainingByProvider>[0]);
    expect(remaining.get("codex")).toBe(0.75);
    expect(remaining.get("claude-code")).toBe(0);
    expect(remaining.get("acp-cursor")).toBe(0.5);
  });
});

describe("escalation windows", () => {
  const rule: EscalationRule = {
    id: "codex-to-claude",
    fromProvider: "codex",
    toModel: "claude-code/claude-fable-5",
    responseLimit: 2,
    handoffNote: "Continue with the established context.",
  };

  it("does not trigger when the source provider still has quota", async () => {
    const storage = new Map<string, unknown>();
    await expect(
      checkEscalation(fakeBb(storage), [rule], new Map([["codex", 0.5]])),
    ).resolves.toBeNull();
    expect(storage.get("escalation-state")).toBeUndefined();
  });

  it("starts a window when the source provider is exhausted", async () => {
    const storage = new Map<string, unknown>();
    await expect(
      checkEscalation(fakeBb(storage), [rule], new Map([["codex", 0]])),
    ).resolves.toEqual({ rule, note: rule.handoffNote });
    expect(storage.get("escalation-state")).toEqual({
      [rule.id]: { awaitingRecovery: true, responsesRemaining: rule.responseLimit },
    });
  });

  it("returns an active window without restarting its counter", async () => {
    const storage = new Map<string, unknown>([
      ["escalation-state", { [rule.id]: { awaitingRecovery: true, responsesRemaining: 1 } }],
    ]);
    await expect(
      checkEscalation(fakeBb(storage), [rule], new Map([["codex", 0]])),
    ).resolves.toEqual({ rule, note: rule.handoffNote });
    expect(storage.get("escalation-state")).toEqual({
      [rule.id]: { awaitingRecovery: true, responsesRemaining: 1 },
    });
  });

  it("closes a window without reopening until the source provider recovers", async () => {
    const storage = new Map<string, unknown>([
      ["escalation-state", { [rule.id]: { awaitingRecovery: true, responsesRemaining: 2 } }],
    ]);
    const bb = fakeBb(storage);
    await consumeEscalation(bb, rule.id);
    expect(storage.get("escalation-state")).toEqual({
      [rule.id]: { awaitingRecovery: true, responsesRemaining: 1 },
    });
    await consumeEscalation(bb, rule.id);
    expect(storage.get("escalation-state")).toEqual({
      [rule.id]: { awaitingRecovery: true, responsesRemaining: 0 },
    });
    await expect(
      checkEscalation(bb, [rule], new Map([["codex", 0]])),
    ).resolves.toBeNull();
    await expect(
      checkEscalation(bb, [rule], new Map([["codex", 1]])),
    ).resolves.toBeNull();
    expect(storage.get("escalation-state")).toEqual({});
    await expect(
      checkEscalation(bb, [rule], new Map([["codex", 0]])),
    ).resolves.toEqual({ rule, note: rule.handoffNote });
  });

  it("selects the configured eligible target model or falls through", () => {
    const request = {
      providerId: "codex",
      model: "gpt-5.6-sol",
      permissionMode: "accept-edits",
    } as unknown as NewThreadRequest;
    const target = candidate("claude-code", "claude-fable-5", ["medium"]);
    const quota = new Map([["claude-code", 1]]);
    expect(
      escalationRoute([target], quota, request, 50, 50, rule),
    ).toMatchObject({
      providerId: "claude-code",
      model: "claude-fable-5",
    });
    expect(
      escalationRoute(
        [candidate("claude-code", "claude-fable-4", ["medium"])],
        quota,
        request,
        50,
        50,
        rule,
      ),
    ).toBeNull();
  });
});

describe("leastClassifierPermissionMode", () => {
  it("prefers accept-edits over the more permissive presets", () => {
    expect(leastClassifierPermissionMode(["full", "auto", "accept-edits"])).toBe(
      "accept-edits",
    );
  });

  it("falls back to auto before full when accept-edits is unsupported", () => {
    expect(leastClassifierPermissionMode(["full", "auto"])).toBe("auto");
  });

  it("uses accept-edits when a provider advertises nothing", () => {
    expect(leastClassifierPermissionMode([])).toBe("accept-edits");
  });
});


describe("per-difficulty band selection (native two-sided ranges)", () => {
  const request = {
    providerId: "codex",
    model: "gpt-5.6-sol",
    permissionMode: "accept-edits",
  } as unknown as NewThreadRequest;
  const allThree = [
    candidate("antigravity", "gemini-3.7-flash-high", ["medium"]),
    candidate("codex", "gpt-5.6-luna", ["low", "medium"]),
    candidate("claude-code", "claude-fable-5", ["low", "medium"]),
  ];
  const fullQuota = new Map([
    ["antigravity", 1],
    ["codex", 1],
    ["claude-code", 1],
  ]);
  // Reproduces the plugin's previous hardcoded simple-task band, now as
  // plain settings data instead of constants baked into router.ts.
  // minDifficulty: null means "unbounded below" (matches down to 0).
  const simpleTaskBand = [
    {
      minDifficulty: null,
      maxDifficulty: 25,
      fallbackChain: ["antigravity", "codex", "claude-code"],
    },
  ];

  it("prefers Antigravity for a simple task when it's available", () => {
    expect(
      difficultyBandSelection(allThree, fullQuota, request, 10, 50, false, simpleTaskBand),
    ).toMatchObject({ providerId: "antigravity" });
  });

  it("falls back to Codex when Antigravity has no candidates", () => {
    const withoutAntigravity = allThree.filter(
      (candidate) => candidate.providerId !== "antigravity",
    );
    expect(
      difficultyBandSelection(
        withoutAntigravity,
        fullQuota,
        request,
        10,
        50,
        false,
        simpleTaskBand,
      ),
    ).toMatchObject({ providerId: "codex" });
  });

  it("falls back to Claude Code when Antigravity and Codex are both unavailable", () => {
    const onlyClaude = allThree.filter(
      (candidate) => candidate.providerId === "claude-code",
    );
    expect(
      difficultyBandSelection(onlyClaude, fullQuota, request, 10, 50, false, simpleTaskBand),
    ).toMatchObject({ providerId: "claude-code" });
  });

  it("respects quota exhaustion, not just candidate presence", () => {
    const antigravityOutOfQuota = new Map([
      ["antigravity", 0],
      ["codex", 1],
      ["claude-code", 1],
    ]);
    expect(
      difficultyBandSelection(
        allThree,
        antigravityOutOfQuota,
        request,
        10,
        50,
        false,
        simpleTaskBand,
      ),
    ).toMatchObject({ providerId: "codex" });
  });

  it("does not apply above the band's upper bound", () => {
    expect(
      difficultyBandSelection(allThree, fullQuota, request, 30, 50, false, simpleTaskBand),
    ).toBeNull();
  });

  it("returns null (defer to benchmark ranking) when none of the chain is eligible", () => {
    const onlyCursor = [candidate("acp-cursor", "composer-2.5", ["medium"])];
    expect(
      difficultyBandSelection(onlyCursor, fullQuota, request, 10, 50, false, simpleTaskBand),
    ).toBeNull();
  });

  it("returns null when no band covers the task's difficulty", () => {
    expect(
      difficultyBandSelection(allThree, fullQuota, request, 10, 50, false, []),
    ).toBeNull();
  });

  it("picks the lowest-threshold band that still covers the difficulty, checked ascending", () => {
    const bands = [
      { minDifficulty: 21, maxDifficulty: 80, fallbackChain: ["claude-code"] },
      { minDifficulty: null, maxDifficulty: 20, fallbackChain: ["antigravity"] },
    ];
    // Listed out of order on purpose -- selection must sort by effective
    // lower bound itself, not rely on array order.
    expect(
      difficultyBandSelection(allThree, fullQuota, request, 15, 50, false, bands),
    ).toMatchObject({ providerId: "antigravity" });
    expect(
      difficultyBandSelection(allThree, fullQuota, request, 50, 50, false, bands),
    ).toMatchObject({ providerId: "claude-code" });
  });

  it("pins an exact provider/model chain entry, not just a bare provider", () => {
    const bands = [
      { minDifficulty: null, maxDifficulty: 25, fallbackChain: ["codex/gpt-5.6-luna"] },
    ];
    const withExtraCodexModel = [
      ...allThree,
      candidate("codex", "gpt-5.6-sol", ["medium"]),
    ];
    const result = difficultyBandSelection(
      withExtraCodexModel,
      fullQuota,
      request,
      10,
      50,
      false,
      bands,
    );
    expect(result).toMatchObject({ providerId: "codex", model: "gpt-5.6-luna" });
  });

  it("routes a genuine two-sided range (e.g. 26-75) distinctly from its neighbors", () => {
    const bands = [
      { minDifficulty: null, maxDifficulty: 25, fallbackChain: ["antigravity"] },
      { minDifficulty: 26, maxDifficulty: 75, fallbackChain: ["codex/gpt-5.6-terra"] },
      { minDifficulty: 76, maxDifficulty: null, fallbackChain: ["claude-code"] },
    ];
    const withTerra = [...allThree, candidate("codex", "gpt-5.6-terra", ["medium"])];
    const quota = new Map([["antigravity", 1], ["codex", 1], ["claude-code", 1]]);

    expect(
      difficultyBandSelection(withTerra, quota, request, 25, 50, false, bands),
    ).toMatchObject({ providerId: "antigravity" });
    expect(
      difficultyBandSelection(withTerra, quota, request, 26, 50, false, bands),
    ).toMatchObject({ providerId: "codex", model: "gpt-5.6-terra" });
    expect(
      difficultyBandSelection(withTerra, quota, request, 75, 50, false, bands),
    ).toMatchObject({ providerId: "codex", model: "gpt-5.6-terra" });
    expect(
      difficultyBandSelection(withTerra, quota, request, 76, 50, false, bands),
    ).toMatchObject({ providerId: "claude-code" });
  });

  it("a fully unbounded band (min and max both null) matches every difficulty", () => {
    const bands = [
      { minDifficulty: null, maxDifficulty: null, fallbackChain: ["claude-code"] },
    ];
    expect(
      difficultyBandSelection(allThree, fullQuota, request, 0, 50, false, bands),
    ).toMatchObject({ providerId: "claude-code" });
    expect(
      difficultyBandSelection(allThree, fullQuota, request, 100, 50, false, bands),
    ).toMatchObject({ providerId: "claude-code" });
  });
});

describe("bandMatchesDifficulty (native range)", () => {
  const band = (minDifficulty: number | null, maxDifficulty: number | null) => ({
    minDifficulty,
    maxDifficulty,
    fallbackChain: [],
  });

  it("unbounded below (min null) matches down to 0", () => {
    expect(bandMatchesDifficulty(0, band(null, 25))).toBe(true);
    expect(bandMatchesDifficulty(25, band(null, 25))).toBe(true);
    expect(bandMatchesDifficulty(26, band(null, 25))).toBe(false);
  });

  it("unbounded above (max null) matches up to 100", () => {
    expect(bandMatchesDifficulty(90, band(75, null))).toBe(true);
    expect(bandMatchesDifficulty(74, band(75, null))).toBe(false);
    expect(bandMatchesDifficulty(100, band(75, null))).toBe(true);
  });

  it("a two-sided range matches only within [min, max] inclusive", () => {
    expect(bandMatchesDifficulty(25, band(26, 75))).toBe(false);
    expect(bandMatchesDifficulty(26, band(26, 75))).toBe(true);
    expect(bandMatchesDifficulty(50, band(26, 75))).toBe(true);
    expect(bandMatchesDifficulty(75, band(26, 75))).toBe(true);
    expect(bandMatchesDifficulty(76, band(26, 75))).toBe(false);
  });

  it("min === max matches only that exact score", () => {
    expect(bandMatchesDifficulty(50, band(50, 50))).toBe(true);
    expect(bandMatchesDifficulty(49, band(50, 50))).toBe(false);
    expect(bandMatchesDifficulty(51, band(50, 50))).toBe(false);
  });

  it("fully unbounded (both null) matches everything", () => {
    expect(bandMatchesDifficulty(0, band(null, null))).toBe(true);
    expect(bandMatchesDifficulty(100, band(null, null))).toBe(true);
  });

  it("difficultyBandSelection actually uses the range, not a hardcoded <=", () => {
    const request = {
      providerId: "codex",
      model: "gpt-5.6-sol",
      permissionMode: "accept-edits",
    } as unknown as NewThreadRequest;
    const highDifficultyOnly = [
      { minDifficulty: 80, maxDifficulty: null, fallbackChain: ["claude-code"] },
    ];
    const quota = new Map([["claude-code", 1]]);
    const claudeOnly = [candidate("claude-code", "claude-fable-5", ["medium"])];

    // A difficulty of 30 must NOT match a "80+" band -- if the band were
    // still hardcoded to "<=", this would incorrectly match.
    expect(
      difficultyBandSelection(claudeOnly, quota, request, 30, 50, false, highDifficultyOnly),
    ).toBeNull();
    expect(
      difficultyBandSelection(claudeOnly, quota, request, 85, 50, false, highDifficultyOnly),
    ).toMatchObject({ providerId: "claude-code" });
  });
});

describe("task-type band selection", () => {
  const request = {
    providerId: "codex",
    model: "gpt-5.6-sol",
    permissionMode: "accept-edits",
  } as unknown as NewThreadRequest;
  const candidates = [
    candidate("antigravity", "gemini-3.7-flash-high", ["medium"]),
    candidate("codex", "gpt-5.6-luna", ["low", "medium"]),
  ];
  const quota = new Map([
    ["antigravity", 1],
    ["codex", 1],
  ]);

  it("returns null without a task type or configured bands", () => {
    expect(
      taskTypeBandSelection(
        candidates,
        quota,
        request,
        null,
        50,
        false,
        [{ taskType: "vision", fallbackChain: ["antigravity"] }],
      ),
    ).toBeNull();
    expect(
      taskTypeBandSelection(candidates, quota, request, "vision", 50, false, []),
    ).toBeNull();
  });

  it("uses the matching task type band's fallback chain", () => {
    expect(
      taskTypeBandSelection(
        candidates,
        quota,
        request,
        "vision",
        50,
        false,
        [{ taskType: "vision", fallbackChain: ["antigravity"] }],
      ),
    ).toMatchObject({ providerId: "antigravity" });
  });

  it("matches task type bands case-insensitively", () => {
    expect(
      taskTypeBandSelection(
        candidates,
        quota,
        request,
        "ViSiOn",
        50,
        false,
        [{ taskType: "VISION", fallbackChain: ["antigravity"] }],
      ),
    ).toMatchObject({ providerId: "antigravity" });
  });

  it("returns null when no task type band matches", () => {
    expect(
      taskTypeBandSelection(
        candidates,
        quota,
        request,
        "audio",
        50,
        false,
        [{ taskType: "vision", fallbackChain: ["antigravity"] }],
      ),
    ).toBeNull();
  });

  it("returns null when the matching band's chain has no eligible candidate", () => {
    expect(
      taskTypeBandSelection(
        candidates,
        quota,
        request,
        "vision",
        50,
        false,
        [{ taskType: "vision", fallbackChain: ["claude-code"] }],
      ),
    ).toBeNull();
  });
});
