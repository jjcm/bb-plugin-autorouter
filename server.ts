import {
  defineRpcContract,
  type BbPluginApi,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createRoutedThread } from "./router.js";
import {
  autorouterSettingsPatchSchema,
  autorouterSettingsSchema,
  defaultAutorouterSettings,
  parseStoredSettings,
  type AutorouterSettings,
} from "./settings.js";

const SETTINGS_KEY = "settings";
const MODEL_CATALOG_CACHE_KEY = "model-catalog-cache";
/** Stale-while-revalidate window, matching prompt-enhancer's picker cache. */
const MODEL_CATALOG_CACHE_MAX_AGE_MS = 5 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNewThreadRequest(value: unknown): value is NewThreadRequest {
  if (!isRecord(value) || !isRecord(value.environment)) return false;
  return (
    typeof value.projectId === "string" &&
    typeof value.providerId === "string" &&
    typeof value.model === "string" &&
    typeof value.reasoningLevel === "string" &&
    typeof value.permissionMode === "string" &&
    typeof value.environment.type === "string" &&
    Array.isArray(value.input)
  );
}

const newThreadRequestSchema = z.custom<NewThreadRequest>(
  isNewThreadRequest,
  "Invalid new-thread request",
);

const reasoningLevelSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
  "ultra",
]);

const modelCatalogSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      models: z.array(
        z.object({
          model: z.string(),
          displayName: z.string(),
          isDefault: z.boolean(),
        }),
      ),
    }),
  ),
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

const routeResultSchema = z
  .object({
    benchmarkScore: z.number().nullable(),
    costPerTask: z.number().nullable(),
    difficulty: z.number().int().min(0).max(100),
    frugality: z.number().int().min(0).max(100),
    model: z.string(),
    overrideApplied: z.boolean(),
    permissionMode: z.enum(["accept-edits", "auto", "full"]),
    providerId: z.string(),
    reasoningLevel: reasoningLevelSchema,
    supportsServiceTier: z.boolean(),
    threadId: z.string(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  getSettings: {
    input: z.null(),
    output: autorouterSettingsSchema,
  },
  updateSettings: {
    input: autorouterSettingsPatchSchema,
    output: autorouterSettingsSchema,
  },
  createThread: {
    input: z.object({ request: newThreadRequestSchema }).strict(),
    output: routeResultSchema,
  },
  /**
   * Live provider/model catalog for the decision-agent picker, following
   * the same pattern as bb-plugin-prompt-enhancer's `listModels`: fetch
   * available providers + their models, cache to KV so a settings-page
   * reopen answers instantly, refresh in the background afterward.
   */
  listModels: {
    input: z.null(),
    output: modelCatalogSchema,
  },
});

function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Expected true or false");
}

function formatSettings(settings: AutorouterSettings, json: boolean): string {
  if (json) return `${JSON.stringify(settings)}\n`;
  return [
    `Enabled: ${settings.enabled ? "yes" : "no"}`,
    `Frugality: ${settings.frugality}/100 ($ -> $$$)`,
    `Decision agent: ${settings.decisionAgent}`,
    `Automatic fallback chain: ${
      settings.automaticFallbackChain.length > 0
        ? settings.automaticFallbackChain.join(" -> ")
        : "(none — falls straight to any launchable model)"
    }`,
    `Difficulty bands: ${
      settings.difficultyBands.length > 0
        ? settings.difficultyBands
            .map(
              (band) =>
                `${band.minDifficulty ?? 0}-${band.maxDifficulty ?? 100}: ${band.fallbackChain.join(" -> ") || "(empty)"}`,
            )
            .join(" | ")
        : "(none — always uses benchmark-ranked selection)"
    }`,
    `Task-type bands: ${
      settings.taskTypeBands.length > 0
        ? settings.taskTypeBands
            .map((band) => `${band.taskType}: ${band.fallbackChain.join(" -> ") || "(empty)"}`)
            .join(" | ")
        : "(none)"
    }`,
    `Excluded models: ${settings.excludedModels.length > 0 ? settings.excludedModels.join(", ") : "(none)"}`,
    `Allowed providers: ${settings.allowedProviders.length > 0 ? settings.allowedProviders.join(", ") : "(unrestricted)"}`,
    `Escalation rules: ${
      settings.escalationRules.length > 0
        ? settings.escalationRules
            .map((rule) => `${rule.id} (${rule.fromProvider} exhausted -> ${rule.toModel} for ${rule.responseLimit})`)
            .join(" | ")
        : "(none)"
    }`,
    `Custom instructions: ${settings.customInstructions || "(none)"}`,
    "",
  ].join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  async function readSettings(): Promise<AutorouterSettings> {
    return parseStoredSettings(await bb.storage.kv.get(SETTINGS_KEY));
  }

  async function updateSettings(
    patch: Partial<AutorouterSettings>,
  ): Promise<AutorouterSettings> {
    const next = autorouterSettingsSchema.parse({
      ...(await readSettings()),
      ...patch,
    });
    await bb.storage.kv.set(SETTINGS_KEY, next);
    bb.realtime.publish("settings-changed", next);
    return next;
  }

  if ((await bb.storage.kv.get(SETTINGS_KEY)) === undefined) {
    await bb.storage.kv.set(SETTINGS_KEY, defaultAutorouterSettings);
  }

  // Model catalog for the decision-agent picker. Stale-while-revalidate: a
  // cached catalog (persisted to KV, so a plugin reload still answers
  // instantly) is served immediately and refreshed in the background;
  // concurrent callers share one in-flight fetch.
  let catalogCache: { at: number; catalog: ModelCatalog } | null = null;
  let catalogInflight: Promise<ModelCatalog> | null = null;

  function refreshModelCatalog(): Promise<ModelCatalog> {
    catalogInflight ??= (async () => {
      const available = (await bb.sdk.providers.list({})).filter(
        (provider) => provider.available,
      );
      const settled = await Promise.allSettled(
        available.map(async (provider): Promise<ModelCatalog["providers"][number]> => {
          const result = await bb.sdk.providers.models({ providerId: provider.id });
          return {
            id: provider.id,
            displayName: provider.displayName,
            models: result.models.map((model) => ({
              model: model.model,
              displayName: model.displayName,
              isDefault: model.isDefault,
            })),
          };
        }),
      );
      const catalog: ModelCatalog = {
        providers: settled
          .filter(
            (result): result is PromiseFulfilledResult<ModelCatalog["providers"][number]> =>
              result.status === "fulfilled",
          )
          .map((result) => result.value)
          .filter((provider) => provider.models.length > 0),
      };
      catalogCache = { at: Date.now(), catalog };
      if (catalog.providers.length > 0) {
        void bb.storage.kv.set(MODEL_CATALOG_CACHE_KEY, catalogCache).catch(() => {});
      }
      return catalog;
    })().finally(() => {
      catalogInflight = null;
    });
    return catalogInflight;
  }

  async function listModels(): Promise<ModelCatalog> {
    if (catalogCache === null) {
      const persisted = await bb.storage.kv.get(MODEL_CATALOG_CACHE_KEY);
      const parsed = z
        .object({ at: z.number(), catalog: modelCatalogSchema })
        .safeParse(persisted);
      if (parsed.success) catalogCache = parsed.data;
    }
    if (catalogCache === null) return refreshModelCatalog();
    if (Date.now() - catalogCache.at > MODEL_CATALOG_CACHE_MAX_AGE_MS) {
      void refreshModelCatalog();
    }
    return catalogCache.catalog;
  }

  bb.rpc.register(rpcContract, {
    getSettings: readSettings,
    updateSettings,
    createThread: async ({ request }) =>
      createRoutedThread(bb, request, await readSettings()),
    listModels,
  });

  bb.cli.register({
    name: "autorouter",
    summary: "Route new bb threads by difficulty, quota, and model cost",
    commands: [
      {
        name: "status",
        summary: "Show Autorouter settings",
        usage: "bb autorouter status [--json]",
      },
      {
        name: "config",
        summary: "Update Autorouter settings",
        usage:
          "bb autorouter config [--enabled true|false] [--frugality 0-100] [--decision-agent automatic|provider/model] [--automatic-fallback provider/model,provider/model,...] [--difficulty-bands '[{\"minDifficulty\":N|null,\"maxDifficulty\":N|null,\"fallbackChain\":[...]}]'] [--task-type-bands '[{\"taskType\":str,\"fallbackChain\":[...]}]'] [--excluded-models provider,provider/model,...] [--allowed-providers provider,provider,...] [--escalation-rules '[{\"id\":str,\"fromProvider\":str,\"toModel\":str,\"responseLimit\":N,\"handoffNote\":str}]'] [--instructions text] [--json]",
      },
      {
        name: "route",
        summary: "Create an automatically routed thread in the current project",
        usage: "bb autorouter route --prompt <text> [--json]",
      },
    ],
    async run(argv, ctx) {
      const args = [...argv];
      const jsonIndex = args.indexOf("--json");
      const json = jsonIndex >= 0;
      if (json) args.splice(jsonIndex, 1);
      const command = args.shift() ?? "status";

      try {
        if (command === "status") {
          return {
            exitCode: 0,
            stdout: formatSettings(await readSettings(), json),
          };
        }

        if (command === "config") {
          const patch: Partial<AutorouterSettings> = {};
          while (args.length > 0) {
            const flag = args.shift();
            const value = args.shift();
            if (!flag || value === undefined) {
              throw new Error(
                `Missing value for ${flag ?? "configuration flag"}`,
              );
            }
            if (flag === "--enabled") patch.enabled = parseBoolean(value);
            else if (flag === "--frugality") patch.frugality = Number(value);
            else if (flag === "--decision-agent") patch.decisionAgent = value;
            else if (flag === "--automatic-fallback")
              patch.automaticFallbackChain = value
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0);
            else if (flag === "--difficulty-bands") {
              let parsedBands: unknown;
              try {
                parsedBands = JSON.parse(value);
              } catch {
                throw new Error(
                  '--difficulty-bands expects JSON, e.g. \'[{"minDifficulty":null,"maxDifficulty":25,"fallbackChain":["antigravity","codex"]},{"minDifficulty":26,"maxDifficulty":75,"fallbackChain":["codex/gpt-5.6-terra"]}]\'',
                );
              }
              patch.difficultyBands = parsedBands as AutorouterSettings["difficultyBands"];
            } else if (flag === "--task-type-bands") {
              let parsedTaskBands: unknown;
              try {
                parsedTaskBands = JSON.parse(value);
              } catch {
                throw new Error(
                  '--task-type-bands expects JSON, e.g. \'[{"taskType":"vision","fallbackChain":["antigravity"]}]\'',
                );
              }
              patch.taskTypeBands = parsedTaskBands as AutorouterSettings["taskTypeBands"];
            } else if (flag === "--excluded-models")
              patch.excludedModels = value
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0);
            else if (flag === "--allowed-providers")
              patch.allowedProviders = value
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0);
            else if (flag === "--escalation-rules") {
              let parsedRules: unknown;
              try {
                parsedRules = JSON.parse(value);
              } catch {
                throw new Error(
                  '--escalation-rules expects JSON, e.g. \'[{"id":"claude-to-codex","fromProvider":"claude-code","toModel":"codex/gpt-5.6-terra","responseLimit":3,"handoffNote":"Picking up after Claude hit its usage limit. Check project instructions for current state and required standards before continuing."}]\'',
                );
              }
              patch.escalationRules = parsedRules as AutorouterSettings["escalationRules"];
            } else if (flag === "--instructions")
              patch.customInstructions = value;
            else throw new Error(`Unknown config flag: ${flag}`);
          }
          const parsedPatch = autorouterSettingsPatchSchema.parse(patch);
          return {
            exitCode: 0,
            stdout: formatSettings(await updateSettings(parsedPatch), json),
          };
        }

        if (command === "route") {
          if (!ctx.projectId) {
            throw new Error("Run this command from a bb project thread");
          }
          const promptFlag = args.indexOf("--prompt");
          const prompt =
            promptFlag >= 0
              ? args[promptFlag + 1]
              : args.filter((arg) => !arg.startsWith("--")).join(" ");
          if (!prompt?.trim()) throw new Error("Provide --prompt <text>");

          let environment: NewThreadRequest["environment"] = {
            type: "project-default",
          };
          if (ctx.threadId) {
            const current = await bb.sdk.threads.get({
              threadId: ctx.threadId,
              signal: ctx.signal,
            });
            if (current.environmentId) {
              environment = {
                type: "reuse",
                environmentId: current.environmentId,
              };
            }
          }
          const result = await createRoutedThread(
            bb,
            {
              projectId: ctx.projectId,
              environment,
              input: [{ type: "text", text: prompt.trim(), mentions: [] }],
              providerId: "codex",
              model: "gpt-5.6-luna",
              reasoningLevel: "low",
              permissionMode: "auto",
              executionInputSources: {
                providerId: "explicit",
                model: "explicit",
                reasoningLevel: "explicit",
                permissionMode: "explicit",
              },
            },
            await readSettings(),
          );
          return {
            exitCode: 0,
            stdout: json
              ? `${JSON.stringify(result)}\n`
              : [
                  `Difficulty score: ${result.difficulty}/100`,
                  `Chosen agent: ${result.providerId}/${result.model} (${result.reasoningLevel})`,
                  `Thread: ${result.threadId}`,
                  "",
                ].join("\n"),
          };
        }

        throw new Error(`Unknown command: ${command}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          exitCode: 1,
          stderr: json
            ? `${JSON.stringify({ error: message })}\n`
            : `Autorouter: ${message}\n`,
        };
      }
    },
  });

  bb.log.info("Autorouter loaded");
}
