import type { BbPluginApi, NewThreadRequest } from "@get-bb/plugin-sdk";

export type ReasoningLevel = NewThreadRequest["reasoningLevel"];
export type AvailableModel = Awaited<
  ReturnType<BbPluginApi["sdk"]["providers"]["models"]>
>["models"][number];

export interface AutoModelCandidate {
  model: AvailableModel;
  permissionModes: NewThreadRequest["permissionMode"][];
  providerId: string;
  supportsServiceTier: boolean;
}

export interface AutoModelRankedOption {
  benchmarkScore: number;
  costPerTask: number;
  effectiveCost: number;
  model: string;
  permissionModes: NewThreadRequest["permissionMode"][];
  providerId: string;
  reasoningLevel: ReasoningLevel;
  supportsServiceTier: boolean;
}

/**
 * Providers Autorouter will create a thread on at all. This is the single
 * source of truth — router.ts's candidate discovery and this file's
 * benchmark-based ranking both read it, so the two can no longer drift out
 * of sync (they previously duplicated this as two separate literal sets,
 * and only router.ts's copy was updated when Antigravity was added, so
 * rankAutoModelOptions silently kept excluding it from real ranking).
 */
export const ROUTABLE_PROVIDER_IDS = new Set([
  "codex",
  "claude-code",
  "acp-cursor",
  "antigravity",
]);

export function isRoutableProvider(providerId: string) {
  return ROUTABLE_PROVIDER_IDS.has(providerId);
}

interface CursorBenchmark {
  costPerTask: number;
  family: string;
  reasoningLevel: ReasoningLevel;
  score: number;
}

/**
 * One-time CursorBench 3.2 snapshot from https://cursor.com/evals, captured
 * 2026-07-16. Costs are Cursor's published average USD cost per task.
 * Grok 4.5 scores include the requested relative 10% reduction.
 */
export const CURSOR_BENCHMARKS = [
  {
    family: "claude-fable-5",
    reasoningLevel: "max",
    score: 70.5,
    costPerTask: 17.32,
  },
  {
    family: "claude-fable-5",
    reasoningLevel: "xhigh",
    score: 68.4,
    costPerTask: 11.73,
  },
  {
    family: "gpt-5.6-sol",
    reasoningLevel: "max",
    score: 67.2,
    costPerTask: 5.69,
  },
  {
    family: "grok-4.5",
    reasoningLevel: "high",
    score: 60.03,
    costPerTask: 1.51,
  },
  {
    family: "claude-fable-5",
    reasoningLevel: "high",
    score: 66.5,
    costPerTask: 8.77,
  },
  {
    family: "claude-fable-5",
    reasoningLevel: "medium",
    score: 65.2,
    costPerTask: 6.8,
  },
  {
    family: "grok-4.5",
    reasoningLevel: "medium",
    score: 58.86,
    costPerTask: 1.54,
  },
  {
    family: "gpt-5.6-terra",
    reasoningLevel: "max",
    score: 64.9,
    costPerTask: 2.89,
  },
  {
    family: "gpt-5.6-sol",
    reasoningLevel: "xhigh",
    score: 64.5,
    costPerTask: 3.88,
  },
  {
    family: "grok-4.5",
    reasoningLevel: "low",
    score: 57.15,
    costPerTask: 1.22,
  },
  {
    family: "gpt-5.6-sol",
    reasoningLevel: "high",
    score: 63.5,
    costPerTask: 2.79,
  },
  {
    family: "claude-opus-4-8",
    reasoningLevel: "max",
    score: 62.3,
    costPerTask: 5.77,
  },
  {
    family: "claude-fable-5",
    reasoningLevel: "low",
    score: 62.1,
    costPerTask: 4.46,
  },
  {
    family: "claude-sonnet-5",
    reasoningLevel: "max",
    score: 61.5,
    costPerTask: 6.45,
  },
  {
    family: "gpt-5.6-luna",
    reasoningLevel: "max",
    score: 61.1,
    costPerTask: 1.97,
  },
  {
    family: "gpt-5.6-sol",
    reasoningLevel: "medium",
    score: 60,
    costPerTask: 1.95,
  },
  {
    family: "claude-opus-4-8",
    reasoningLevel: "xhigh",
    score: 59.4,
    costPerTask: 4.5,
  },
  {
    family: "gpt-5.6-terra",
    reasoningLevel: "xhigh",
    score: 59.2,
    costPerTask: 1.44,
  },
  {
    family: "claude-sonnet-5",
    reasoningLevel: "xhigh",
    score: 58.7,
    costPerTask: 4.16,
  },
  { family: "gpt-5.5", reasoningLevel: "high", score: 58.4, costPerTask: 2.05 },
  {
    family: "gpt-5.5",
    reasoningLevel: "xhigh",
    score: 58.4,
    costPerTask: 2.85,
  },
  {
    family: "claude-opus-4-8",
    reasoningLevel: "high",
    score: 58,
    costPerTask: 3.15,
  },
  {
    family: "gpt-5.6-luna",
    reasoningLevel: "xhigh",
    score: 57.7,
    costPerTask: 1.14,
  },
  {
    family: "claude-sonnet-5",
    reasoningLevel: "high",
    score: 56.9,
    costPerTask: 3.19,
  },
  {
    family: "gpt-5.6-luna",
    reasoningLevel: "high",
    score: 56.8,
    costPerTask: 0.82,
  },
  {
    family: "claude-opus-4-8",
    reasoningLevel: "medium",
    score: 56.1,
    costPerTask: 2.81,
  },
  {
    family: "composer-2.5",
    reasoningLevel: "medium",
    score: 56.1,
    costPerTask: 0.44,
  },
  {
    family: "gpt-5.6-terra",
    reasoningLevel: "high",
    score: 54.2,
    costPerTask: 0.89,
  },
  {
    family: "gpt-5.5",
    reasoningLevel: "medium",
    score: 53.8,
    costPerTask: 1.51,
  },
  {
    family: "claude-opus-4-8",
    reasoningLevel: "low",
    score: 53.1,
    costPerTask: 2.02,
  },
  {
    family: "gpt-5.6-sol",
    reasoningLevel: "low",
    score: 52.6,
    costPerTask: 1.01,
  },
  {
    family: "claude-sonnet-5",
    reasoningLevel: "medium",
    score: 52.4,
    costPerTask: 2.16,
  },
  {
    family: "gpt-5.6-terra",
    reasoningLevel: "medium",
    score: 50.3,
    costPerTask: 0.61,
  },
  {
    family: "gpt-5.6-luna",
    reasoningLevel: "medium",
    score: 47.7,
    costPerTask: 0.39,
  },
  {
    family: "claude-sonnet-5",
    reasoningLevel: "low",
    score: 47.7,
    costPerTask: 1.3,
  },
  {
    family: "gpt-5.6-terra",
    reasoningLevel: "low",
    score: 46.9,
    costPerTask: 0.53,
  },
  { family: "gpt-5.5", reasoningLevel: "low", score: 46.6, costPerTask: 0.98 },
  {
    family: "gpt-5.6-luna",
    reasoningLevel: "low",
    score: 37.6,
    costPerTask: 0.16,
  },
] as const satisfies readonly CursorBenchmark[];

const SCORE_EPSILON = 0.001;
const CAPABILITY_BAND_MARGIN = 1;
const COST_TIE_BREAK_WEIGHT = 0.1;
const QUOTA_PENALTY_PER_HALVING = 1.5;

interface CapabilityAnchor {
  difficulty: number;
  score: number;
}

const CHEAP_CAPABILITY_CURVE = [
  { difficulty: 1, score: 37.6 },
  { difficulty: 50, score: 56.8 },
  { difficulty: 75, score: 58.86 },
  { difficulty: 100, score: 60 },
] as const satisfies readonly CapabilityAnchor[];

const PREMIUM_CAPABILITY_CURVE = [
  { difficulty: 1, score: 58.86 },
  { difficulty: 50, score: 63.5 },
  { difficulty: 75, score: 66.5 },
  { difficulty: 100, score: 70.5 },
] as const satisfies readonly CapabilityAnchor[];

function benchmarkFamily(model: string): string | null {
  const normalizedModel = model.toLowerCase();
  return (
    CURSOR_BENCHMARKS.find((row) => normalizedModel.includes(row.family))
      ?.family ?? null
  );
}

function normalized(value: number, minimum: number, maximum: number): number {
  return maximum === minimum ? 0 : (value - minimum) / (maximum - minimum);
}

function interpolateCurve(
  curve: readonly CapabilityAnchor[],
  difficulty: number,
): number {
  const boundedDifficulty = Math.max(1, Math.min(100, difficulty));
  const upperIndex = curve.findIndex(
    (anchor) => anchor.difficulty >= boundedDifficulty,
  );
  if (upperIndex <= 0) return curve[0]?.score ?? 0;
  const upper = curve[upperIndex];
  const lower = curve[upperIndex - 1];
  if (!upper || !lower) return curve.at(-1)?.score ?? 0;
  const progress =
    (boundedDifficulty - lower.difficulty) /
    (upper.difficulty - lower.difficulty);
  return lower.score + progress * (upper.score - lower.score);
}

function capabilityBand(args: { difficulty: number; frugality: number }) {
  const cheapScore = interpolateCurve(CHEAP_CAPABILITY_CURVE, args.difficulty);
  const premiumScore = interpolateCurve(
    PREMIUM_CAPABILITY_CURVE,
    args.difficulty,
  );
  const preference = Math.max(0, Math.min(100, args.frugality)) / 100;
  return {
    maximum: Math.max(cheapScore, premiumScore),
    minimum: Math.min(cheapScore, premiumScore),
    preference,
    target: cheapScore + (premiumScore - cheapScore) * preference,
  };
}

function quotaPenalty(option: AutoModelRankedOption): number {
  const quotaRemaining = Math.min(1, option.costPerTask / option.effectiveCost);
  return (
    Math.log2(1 / Math.max(quotaRemaining, 0.01)) * QUOTA_PENALTY_PER_HALVING
  );
}

function compareByCost(
  left: AutoModelRankedOption,
  right: AutoModelRankedOption,
): number {
  return (
    left.effectiveCost - right.effectiveCost ||
    left.benchmarkScore - right.benchmarkScore ||
    left.costPerTask - right.costPerTask ||
    left.providerId.localeCompare(right.providerId) ||
    left.model.localeCompare(right.model)
  );
}

function rankByCapabilityTarget(
  options: AutoModelRankedOption[],
  target: number,
  preference: number,
): AutoModelRankedOption[] {
  const costs = options.map((option) => option.costPerTask);
  const minimumCost = Math.min(...costs);
  const maximumCost = Math.max(...costs);
  const loss = (option: AutoModelRankedOption): number => {
    const cost = normalized(option.costPerTask, minimumCost, maximumCost);
    const costPreferenceLoss =
      (cost * (1 - preference) + (1 - cost) * preference) *
      COST_TIE_BREAK_WEIGHT;
    return (
      Math.abs(option.benchmarkScore - target) +
      quotaPenalty(option) +
      costPreferenceLoss
    );
  };
  return options.sort(
    (left, right) =>
      loss(left) - loss(right) ||
      (preference >= 0.5
        ? right.costPerTask - left.costPerTask
        : compareByCost(left, right)),
  );
}

export function rankAutoModelOptions(args: {
  candidates: AutoModelCandidate[];
  difficulty: number;
  frugality: number;
  quotaRemainingByProvider: ReadonlyMap<string, number>;
}): AutoModelRankedOption[] {
  const supportedProviders = ROUTABLE_PROVIDER_IDS;
  const options = args.candidates.flatMap((candidate) => {
    if (!supportedProviders.has(candidate.providerId)) return [];
    const family = benchmarkFamily(candidate.model.model);
    if (family === null) return [];
    const supportedReasoning = new Set(
      candidate.model.supportedReasoningEfforts.map(
        (effort) => effort.reasoningEffort,
      ),
    );
    const quotaRemaining =
      args.quotaRemainingByProvider.get(candidate.providerId) ?? 1;
    if (quotaRemaining <= 0) return [];
    return CURSOR_BENCHMARKS.filter(
      (row) =>
        row.family === family && supportedReasoning.has(row.reasoningLevel),
    ).map(
      (row): AutoModelRankedOption => ({
        benchmarkScore: row.score,
        costPerTask: row.costPerTask,
        effectiveCost: row.costPerTask / quotaRemaining,
        model: candidate.model.model,
        permissionModes: candidate.permissionModes,
        providerId: candidate.providerId,
        reasoningLevel: row.reasoningLevel,
        supportsServiceTier: candidate.supportsServiceTier,
      }),
    );
  });
  const band = capabilityBand(args);
  const bounded = options.filter(
    (option) =>
      option.benchmarkScore >=
        band.minimum - CAPABILITY_BAND_MARGIN - SCORE_EPSILON &&
      option.benchmarkScore <=
        band.maximum + CAPABILITY_BAND_MARGIN + SCORE_EPSILON,
  );
  return rankByCapabilityTarget(
    bounded.length > 0 ? bounded : options,
    band.target,
    band.preference,
  );
}
