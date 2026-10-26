import type { BbPluginApi, NewThreadRequest } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  rankAutoModelOptions,
  type AutoModelCandidate,
  type AutoModelRankedOption,
  type ReasoningLevel,
} from "./benchmarks.js";
import {
  AUTOMATIC_DECISION_AGENT,
  type AutorouterSettings,
} from "./settings.js";

const MAX_TASK_TEXT_LENGTH = 20_000;
const DEFAULT_DIFFICULTY = 50;
const CLASSIFIER_TIMEOUT_MS = 60_000;

const difficultyDecisionSchema = z
  .object({
    difficulty: z.number().int().min(0).max(100),
    modelOverride: z.string().min(1).max(200).optional(),
  })
  .strict();

interface DifficultyDecision {
  difficulty: number;
  modelOverride: string | null;
}

export interface ResolvedRoute {
  benchmarkScore: number | null;
  costPerTask: number | null;
  difficulty: number;
  frugality: number;
  model: string;
  overrideApplied: boolean;
  permissionMode: NewThreadRequest["permissionMode"];
  providerId: string;
  reasoningLevel: ReasoningLevel;
  supportsServiceTier: boolean;
}

export interface RoutedThreadResult extends ResolvedRoute {
  threadId: string;
}

type UsageEntry = Awaited<
  ReturnType<BbPluginApi["sdk"]["system"]["usageLimits"]>
>["codex"];
type LegacyUsageResponse = {
  codex: UsageEntry;
  claudeCode: UsageEntry;
  cursor: UsageEntry;
};
type ProviderUsageResponse = {
  codex: UsageEntry;
  "claude-code": UsageEntry;
  "acp-cursor": UsageEntry;
};
type UsageResponse = LegacyUsageResponse | ProviderUsageResponse;

function isUsageResponse(
  usage: Partial<LegacyUsageResponse & ProviderUsageResponse>,
): usage is UsageResponse {
  return (
    usage.codex !== undefined &&
    ((usage["claude-code"] !== undefined && usage["acp-cursor"] !== undefined) ||
      (usage.claudeCode !== undefined && usage.cursor !== undefined))
  );
}

function taskText(input: NewThreadRequest["input"]): string {
  return input
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "localFile") return `[File: ${part.name ?? part.path}]`;
      if (part.type === "localImage") return "[Attached image]";
      return "[Remote image]";
    })
    .join("\n")
    .trim()
    .slice(0, MAX_TASK_TEXT_LENGTH);
}

function normalizeModelName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function candidateNames(candidate: AutoModelCandidate): string[] {
  return [
    candidate.model.id,
    candidate.model.model,
    candidate.model.displayName,
    `${candidate.providerId}/${candidate.model.model}`,
  ];
}

export function matchModelOverride(
  candidates: AutoModelCandidate[],
  requestedModel: string,
): AutoModelCandidate[] {
  const requested = normalizeModelName(requestedModel);
  if (requested.length < 4) return [];
  const exact = candidates.filter((candidate) =>
    candidateNames(candidate).some(
      (name) => normalizeModelName(name) === requested,
    ),
  );
  if (exact.length > 0) return exact;
  return candidates.filter((candidate) =>
    candidateNames(candidate).some((name) => {
      const normalized = normalizeModelName(name);
      return normalized.includes(requested) || requested.includes(normalized);
    }),
  );
}

export function isModelOverrideGrounded(
  requestedModel: string,
  candidates: AutoModelCandidate[],
  sources: readonly string[],
): boolean {
  const source = normalizeModelName(sources.join("\n"));
  if (source.includes(normalizeModelName(requestedModel))) return true;
  return candidates.some((candidate) =>
    candidateNames(candidate)
      .map(normalizeModelName)
      .filter((name) => name.length >= 4)
      .some((name) => source.includes(name)),
  );
}

function remainingQuota(
  usage: UsageEntry,
  options: { useSpendWhenIncludedQuotaIsExhausted: boolean },
): number {
  if (
    usage.status === "not_installed" ||
    usage.status === "unauthenticated" ||
    usage.status === "expired"
  ) {
    return 0;
  }
  if (usage.status === "error" || usage.windows.length === 0) return 1;
  const includedWindows = usage.windows.filter(
    (window) => window.cost === undefined,
  );
  const includedRemaining = Math.max(
    0,
    1 -
      Math.max(
        ...(includedWindows.length > 0 ? includedWindows : usage.windows).map(
          (window) => window.usedPercent,
        ),
      ) /
        100,
  );
  if (includedRemaining > 0 || !options.useSpendWhenIncludedQuotaIsExhausted) {
    return includedRemaining;
  }
  const spendWindows = usage.windows.filter(
    (window) => window.cost !== undefined,
  );
  return spendWindows.length === 0
    ? 0
    : Math.max(
        0,
        1 - Math.max(...spendWindows.map((window) => window.usedPercent)) / 100,
      );
}

export function quotaRemainingByProvider(
  usage: UsageResponse,
): ReadonlyMap<string, number> {
  return new Map([
    [
      "codex",
      remainingQuota(usage.codex, {
        useSpendWhenIncludedQuotaIsExhausted: false,
      }),
    ],
    [
      "claude-code",
      remainingQuota(
        "claude-code" in usage ? usage["claude-code"] : usage.claudeCode,
        { useSpendWhenIncludedQuotaIsExhausted: false },
      ),
    ],
    [
      "acp-cursor",
      remainingQuota(
        "acp-cursor" in usage ? usage["acp-cursor"] : usage.cursor,
        { useSpendWhenIncludedQuotaIsExhausted: true },
      ),
    ],
  ]);
}

function difficultyPrompt(args: {
  customInstructions: string;
  task: string;
}): string {
  return [
    "Immediately rate the task's software-engineering difficulty from 0 to 100.",
    "0 means a one-line CSS change. 100 means the most difficult, ambiguous, security-critical, multi-system task possible.",
    "Consider scope, ambiguity, required reasoning, security risk, and how much code must be understood or changed.",
    "Do not solve, explain, analyze, or provide reasoning.",
    'Return only compact JSON: {"difficulty": NUMBER}.',
    'Add "modelOverride" only when the task explicitly asks for a specific model, or when the user instructions below explicitly require a specific model for this task.',
    "Never choose or recommend a model on your own. When set, copy the requested model name as closely as possible.",
    args.customInstructions.trim()
      ? `User rating instructions:\n${args.customInstructions.trim()}`
      : "",
    `Task:\n${args.task}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseDifficultyDecision(output: string): DifficultyDecision {
  const trimmed = output.trim();
  const objectText = trimmed.match(/\{[\s\S]*\}/u)?.[0];
  if (objectText) {
    try {
      const parsed = difficultyDecisionSchema.safeParse(JSON.parse(objectText));
      if (parsed.success) {
        return {
          difficulty: parsed.data.difficulty,
          modelOverride: parsed.data.modelOverride?.trim() || null,
        };
      }
    } catch {
      // Fall through to the integer-only compatibility parser.
    }
  }
  const integer = trimmed.match(/(?:^|\D)(100|[1-9]?\d)(?:\D|$)/u)?.[1];
  if (integer !== undefined) {
    return { difficulty: Number(integer), modelOverride: null };
  }
  throw new Error("The difficulty agent did not return a 0-100 score");
}

function discoveryEnvironment(
  request: NewThreadRequest,
):
  | { kind: "environment"; environmentId: string }
  | { kind: "host"; hostId: string }
  | { kind: "primary" } {
  if (request.environment.type === "reuse") {
    return {
      kind: "environment",
      environmentId: request.environment.environmentId,
    };
  }
  if (request.environment.type === "host" && request.environment.hostId) {
    return { kind: "host", hostId: request.environment.hostId };
  }
  return { kind: "primary" };
}

async function listProviders(
  bb: BbPluginApi,
  route: ReturnType<typeof discoveryEnvironment>,
) {
  if (route.kind === "environment") {
    return bb.sdk.providers.list({ environmentId: route.environmentId });
  }
  if (route.kind === "host") {
    return bb.sdk.providers.list({ hostId: route.hostId });
  }
  return bb.sdk.providers.list();
}

async function listProviderModels(
  bb: BbPluginApi,
  route: ReturnType<typeof discoveryEnvironment>,
  providerId: string,
) {
  if (route.kind === "environment") {
    return bb.sdk.providers.models({
      environmentId: route.environmentId,
      providerId,
    });
  }
  if (route.kind === "host") {
    return bb.sdk.providers.models({ hostId: route.hostId, providerId });
  }
  return bb.sdk.providers.models({ providerId });
}

async function loadCandidates(
  bb: BbPluginApi,
  request: NewThreadRequest,
): Promise<AutoModelCandidate[]> {
  const route = discoveryEnvironment(request);
  const providers = await listProviders(bb, route);
  const providerById = new Map(
    providers.map((provider) => [provider.id, provider]),
  );
  const supported = providers.filter(
    (provider) =>
      provider.available &&
      new Set(["codex", "claude-code", "acp-cursor"]).has(provider.id),
  );
  const results = await Promise.all(
    supported.map(async (provider) => ({
      provider,
      options: await listProviderModels(bb, route, provider.id),
    })),
  );
  const seen = new Set<string>();
  return results.flatMap(({ provider, options }) => {
    if (options.modelLoadError !== null) return [];
    return options.models.flatMap((model) => {
      const providerId = model.routeProviderId ?? provider.id;
      const actualProvider = providerById.get(providerId) ?? provider;
      const key = `${providerId}/${model.model}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          model,
          permissionModes: [...actualProvider.capabilities.permissionModes],
          providerId,
          supportsServiceTier: actualProvider.capabilities.supportsServiceTier,
        },
      ];
    });
  });
}

async function loadUsage(
  bb: BbPluginApi,
  request: NewThreadRequest,
): Promise<Partial<LegacyUsageResponse & ProviderUsageResponse>> {
  const route = discoveryEnvironment(request);
  if (route.kind === "host") {
    return bb.sdk.system.usageLimits({ hostId: route.hostId });
  }
  if (route.kind === "environment") {
    const environment = await bb.sdk.environments.get({
      environmentId: route.environmentId,
    });
    return bb.sdk.system.usageLimits({ hostId: environment.hostId });
  }
  return bb.sdk.system.usageLimits();
}

const reasoningOrder: ReasoningLevel[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
  "ultra",
];

export function leastClassifierReasoning(
  candidate: AutoModelCandidate,
): ReasoningLevel {
  const supported = new Set(
    candidate.model.supportedReasoningEfforts.map(
      (effort) => effort.reasoningEffort,
    ),
  );
  // Cursor's model rows expose `none`, but the ACP provider launch contract
  // currently rejects it. Keep the classifier at the provider's true minimum.
  const launchableOrder =
    candidate.providerId === "acp-cursor"
      ? reasoningOrder.filter((level) => level !== "none")
      : reasoningOrder;
  return (
    launchableOrder.find((level) => supported.has(level)) ??
    candidate.model.defaultReasoningEffort
  );
}

function classifierCandidate(
  candidates: AutoModelCandidate[],
  settings: AutorouterSettings,
  quota: ReadonlyMap<string, number>,
): { candidate: AutoModelCandidate; reasoningLevel: ReasoningLevel } | null {
  const usable = candidates.filter(
    (candidate) => (quota.get(candidate.providerId) ?? 1) > 0,
  );
  const exact = (providerId: string, model: string) =>
    usable.find(
      (candidate) =>
        candidate.providerId === providerId &&
        (candidate.model.model === model || candidate.model.id === model),
    );
  const configured = settings.decisionAgent.split("/", 2);
  const selected =
    settings.decisionAgent === AUTOMATIC_DECISION_AGENT
      ? (exact("acp-cursor", "gpt-5.6-sol-medium") ??
        exact("codex", "gpt-5.6-luna") ??
        usable.find((candidate) =>
          candidate.model.supportedReasoningEfforts.some(
            (effort) => effort.reasoningEffort === "none",
          ),
        ) ??
        usable[0])
      : configured.length === 2
        ? exact(configured[0] ?? "", configured[1] ?? "")
        : undefined;
  if (!selected) return null;
  return {
    candidate: selected,
    reasoningLevel: leastClassifierReasoning(selected),
  };
}

// bb 0.39 exposes exactly three presets, ordered least to most privileged.
// There is no read-only preset a plugin can request, so `accept-edits` is the
// floor; picking it explicitly (rather than the provider's first advertised
// mode) keeps the classifier off `auto` and `full`.
const permissionModeOrder = [
  "accept-edits",
  "auto",
  "full",
] as const satisfies readonly NewThreadRequest["permissionMode"][];

export function leastClassifierPermissionMode(
  supported: NewThreadRequest["permissionMode"][],
): NewThreadRequest["permissionMode"] {
  const available = new Set(supported);
  return (
    permissionModeOrder.find((mode) => available.has(mode)) ?? "accept-edits"
  );
}

// The classifier reads untrusted prompt text, so it never runs in the
// environment the routed thread is headed for. `project-default` keeps it out
// of the user's own checkout and out of any environment they asked to reuse,
// which bounds a prompt-injected classification turn to a throwaway workspace.
function classifierEnvironment(): NewThreadRequest["environment"] {
  return { type: "project-default" };
}

async function classifyDifficulty(
  bb: BbPluginApi,
  args: {
    candidates: AutoModelCandidate[];
    quota: ReadonlyMap<string, number>;
    request: NewThreadRequest;
    settings: AutorouterSettings;
    task: string;
  },
): Promise<DifficultyDecision> {
  const classifier = classifierCandidate(
    args.candidates,
    args.settings,
    args.quota,
  );
  if (!classifier) {
    throw new Error("No configured difficulty agent is available");
  }
  const permissionMode = leastClassifierPermissionMode(
    classifier.candidate.permissionModes,
  );
  const worker = await bb.sdk.threads.spawn({
    projectId: args.request.projectId,
    environment: classifierEnvironment(),
    input: [
      {
        type: "text",
        mentions: [],
        text: difficultyPrompt({
          customInstructions: args.settings.customInstructions,
          task: args.task,
        }),
      },
    ],
    providerId: classifier.candidate.providerId,
    model: classifier.candidate.model.model,
    reasoningLevel: classifier.reasoningLevel,
    permissionMode,
    executionInputSources: {
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
      permissionMode: "explicit",
    },
    title: "Autorouter classification",
    visibility: "hidden",
  });
  try {
    await bb.sdk.threads.wait({
      threadId: worker.id,
      status: "idle",
      timeoutMs: CLASSIFIER_TIMEOUT_MS,
    });
    const { output } = await bb.sdk.threads.output({ threadId: worker.id });
    if (!output) throw new Error("The difficulty agent returned no output");
    return parseDifficultyDecision(output);
  } finally {
    await bb.sdk.threads
      .archive({ threadId: worker.id })
      .catch(() => undefined);
    await bb.sdk.threads.stop({ threadId: worker.id }).catch(() => undefined);
  }
}

function safePermissionMode(
  requested: NewThreadRequest["permissionMode"],
  supported: NewThreadRequest["permissionMode"][],
): NewThreadRequest["permissionMode"] {
  if (supported.includes(requested)) return requested;
  if (supported.includes("accept-edits")) return "accept-edits";
  if (requested === "full" && supported.includes("auto")) return "auto";
  return supported[0] ?? "accept-edits";
}

function fallbackSelection(
  candidates: AutoModelCandidate[],
  request: NewThreadRequest,
  difficulty: number,
  frugality: number,
  overrideApplied: boolean,
): ResolvedRoute {
  const selected =
    candidates.find(
      (candidate) =>
        candidate.providerId === request.providerId &&
        (candidate.model.model === request.model ||
          candidate.model.id === request.model),
    ) ??
    candidates.find(
      (candidate) =>
        candidate.providerId === request.providerId &&
        candidate.model.isDefault,
    ) ??
    candidates.find((candidate) => candidate.model.isDefault) ??
    candidates[0];
  if (!selected)
    throw new Error("Autorouter found no available provider model");
  return {
    benchmarkScore: null,
    costPerTask: null,
    difficulty,
    frugality,
    model: selected.model.model,
    overrideApplied,
    permissionMode: safePermissionMode(
      request.permissionMode,
      selected.permissionModes,
    ),
    providerId: selected.providerId,
    reasoningLevel: selected.model.defaultReasoningEffort,
    supportsServiceTier: selected.supportsServiceTier,
  };
}

function rankedSelection(
  selected: AutoModelRankedOption,
  request: NewThreadRequest,
  difficulty: number,
  frugality: number,
  overrideApplied: boolean,
): ResolvedRoute {
  return {
    benchmarkScore: selected.benchmarkScore,
    costPerTask: selected.costPerTask,
    difficulty,
    frugality,
    model: selected.model,
    overrideApplied,
    permissionMode: safePermissionMode(
      request.permissionMode,
      selected.permissionModes,
    ),
    providerId: selected.providerId,
    reasoningLevel: selected.reasoningLevel,
    supportsServiceTier: selected.supportsServiceTier,
  };
}

export async function resolveRoute(
  bb: BbPluginApi,
  request: NewThreadRequest,
  settings: AutorouterSettings,
): Promise<ResolvedRoute> {
  if (!settings.enabled) throw new Error("Autorouter is disabled");
  const candidates = await loadCandidates(bb, request);
  const usage = await loadUsage(bb, request);
  if (!isUsageResponse(usage)) {
    throw new Error("BB returned an incomplete provider usage response");
  }
  const quota = quotaRemainingByProvider(usage);
  const task = taskText(request.input);
  let decision: DifficultyDecision = {
    difficulty: DEFAULT_DIFFICULTY,
    modelOverride: null,
  };
  try {
    decision = await classifyDifficulty(bb, {
      candidates,
      quota,
      request,
      settings,
      task,
    });
  } catch (error) {
    bb.log.warn(
      `Difficulty classification failed; using ${DEFAULT_DIFFICULTY}/100: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const matchedOverride = decision.modelOverride
    ? matchModelOverride(candidates, decision.modelOverride)
    : [];
  const groundedOverride =
    decision.modelOverride !== null &&
    isModelOverrideGrounded(decision.modelOverride, matchedOverride, [
      task,
      settings.customInstructions,
    ])
      ? matchedOverride
      : [];
  if (decision.modelOverride && groundedOverride.length === 0) {
    bb.log.warn(
      `Ignoring unavailable or ungrounded model override: ${decision.modelOverride}`,
    );
  }
  const quotaEligible = candidates.filter(
    (candidate) => (quota.get(candidate.providerId) ?? 1) > 0,
  );
  const eligibleOverride = groundedOverride.filter(
    (candidate) => (quota.get(candidate.providerId) ?? 1) > 0,
  );
  const selectionCandidates =
    eligibleOverride.length > 0 ? eligibleOverride : quotaEligible;
  const overrideApplied = eligibleOverride.length > 0;
  const ranked = rankAutoModelOptions({
    candidates: selectionCandidates,
    difficulty: decision.difficulty,
    frugality: settings.frugality,
    quotaRemainingByProvider: quota,
  })[0];
  return ranked
    ? rankedSelection(
        ranked,
        request,
        decision.difficulty,
        settings.frugality,
        overrideApplied,
      )
    : fallbackSelection(
        selectionCandidates,
        request,
        decision.difficulty,
        settings.frugality,
        overrideApplied,
      );
}

export async function createRoutedThread(
  bb: BbPluginApi,
  request: NewThreadRequest,
  settings: AutorouterSettings,
): Promise<RoutedThreadResult> {
  const route = await resolveRoute(bb, request, settings);
  const { serviceTier: requestedServiceTier, ...requestWithoutServiceTier } =
    request;
  const thread = await bb.sdk.threads.spawn({
    ...requestWithoutServiceTier,
    ...(route.supportsServiceTier && requestedServiceTier
      ? { serviceTier: requestedServiceTier }
      : {}),
    providerId: route.providerId,
    model: route.model,
    reasoningLevel: route.reasoningLevel,
    permissionMode: route.permissionMode,
    executionInputSources: {
      ...request.executionInputSources,
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
      permissionMode: "explicit",
      ...(route.supportsServiceTier && requestedServiceTier
        ? { serviceTier: "explicit" as const }
        : {}),
    },
  });
  bb.log.info(
    `Routed ${thread.id}: difficulty ${route.difficulty}/100 -> ${route.providerId}/${route.model} (${route.reasoningLevel})`,
  );
  return { ...route, threadId: thread.id };
}
