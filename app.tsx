import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  definePluginApp,
  experimental_NewThreadComposer as NewThreadComposer,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ModelCatalog, rpcContract } from "./server";
import type { RoutedThreadResult } from "./router";
import type { AutorouterSettings, DifficultyBand } from "./settings";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Icon } from "@/components/ui/icon";
import {
  SELECTING_LABEL_BASE,
  SELECTING_LABEL_INTERVAL_MS,
  selectingLabel,
  toCssContentString,
} from "./selecting-label";
import "./autorouter.css";

/** Swaps the entries at `from` and `to`; out-of-range indices are a no-op. */
function moveEntry<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return [...list];
  const next = [...list];
  [next[from], next[to]] = [next[to] as T, next[from] as T];
  return next;
}

const AUTO_ROUTER_COMPOSE_LAYOUT_CLASS =
  "mx-auto flex w-full max-w-[760px] flex-col px-4 pb-4 pt-14";

/**
 * Drives the picker label's dot cycle. Idle rounds hold no timer, so the page
 * is inert until a submission is actually being routed.
 */
function useSelectingLabel(active: boolean): string | null {
  const [tick, setTick] = useState(0);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (!active) {
      setTick(0);
      return;
    }
    if (reducedMotion) return;
    const timer = setInterval(
      () => setTick((previous) => previous + 1),
      SELECTING_LABEL_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [active, reducedMotion]);

  return active ? selectingLabel(tick, reducedMotion) : null;
}

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(query.matches);
    const onChange = (event: MediaQueryListEvent) =>
      setReducedMotion(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reducedMotion;
}

function AutoRouterPage() {
  const { projectId } = useBbContext();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "selecting" }
    | { kind: "selected"; result: RoutedThreadResult }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const selectingText = useSelectingLabel(status.kind === "selecting");

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div
        className={AUTO_ROUTER_COMPOSE_LAYOUT_CLASS}
        style={
          selectingText
            ? ({
                "--autorouter-picker-label": toCssContentString(selectingText),
              } as CSSProperties)
            : undefined
        }
      >
        <NewThreadComposer
          defaultProjectId={projectId ?? undefined}
          className="autorouter-composer"
          draftKey="autorouter-new-thread"
          layout="document"
          onSubmit={async (request) => {
            setStatus({ kind: "selecting" });
            try {
              const result = await rpc.call("createThread", { request });
              setStatus({ kind: "selected", result });
              navigate.toThread(result.threadId);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Auto routing failed";
              setStatus({ kind: "error", message });
              toast.error(message);
              throw error;
            }
          }}
        />
        <div className="min-h-6 text-sm" aria-live="polite">
          {/*
            While routing, the visible status lives in the composer's picker
            button (see autorouter.css). The cycling dots would be read out on
            every frame, so assistive tech gets the announcement once, without
            them.
          */}
          {status.kind === "selecting" ? (
            <p className="sr-only">{`${SELECTING_LABEL_BASE}…`}</p>
          ) : null}
          {status.kind === "error" ? (
            <p className="mx-2 text-destructive">{status.message}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface CatalogState {
  status: "loading" | "ready" | "failed";
  catalog: ModelCatalog | null;
}

type UpdateSettings = (
  patch: Partial<AutorouterSettings>,
  options?: { debounceMs?: number },
) => void;

/** Empty means "unbounded" on that side; the input shows a blank field. */
function boundInputValue(bound: number | null): string {
  return bound === null ? "" : String(bound);
}

function parseBoundInput(raw: string): number | null {
  if (raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

/**
 * Per-difficulty model selection: an ordered list of difficulty bands, each
 * a native two-sided range (`minDifficulty`/`maxDifficulty`, either end
 * nullable for "unbounded") plus its own fallback chain. Checked low to
 * high by effective lower bound. Mirrors the Decision agent section's
 * fallback-order editor, just scoped per band instead of to the classifier
 * — same list/reorder/remove pattern, plus a per-band model picker and
 * add/remove band controls.
 */
function DifficultyBandsSection({
  settings,
  update,
  picker,
}: {
  settings: AutorouterSettings;
  update: UpdateSettings;
  picker: CatalogState;
}) {
  function updateBand(index: number, patch: Partial<DifficultyBand>) {
    update({
      difficultyBands: settings.difficultyBands.map((band, i) =>
        i === index ? { ...band, ...patch } : band,
      ),
    });
  }

  function removeBand(index: number) {
    update({
      difficultyBands: settings.difficultyBands.filter((_, i) => i !== index),
    });
  }

  function addBand() {
    update({
      difficultyBands: [
        ...settings.difficultyBands,
        { minDifficulty: null, maxDifficulty: 50, fallbackChain: [] },
      ],
    });
  }

  const sortedForDisplay = [...settings.difficultyBands]
    .map((band, index) => ({ band, index }))
    .sort((a, b) => (a.band.minDifficulty ?? -1) - (b.band.minDifficulty ?? -1));

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">Per-difficulty model selection</label>
      <p className="text-xs text-muted-foreground">
        Route tasks whose difficulty falls in a range straight through a
        fixed fallback chain instead of the normal benchmark-ranked
        selection — e.g. 0–25 for one model, 26–75 for another. Leave either
        side blank for an open-ended range (blank min = 0, blank max = 100).
        Checked low to high — the first band that covers a task's difficulty
        score wins. Empty by default beyond whatever bands you add here;
        there is no hardcoded difficulty cutoff.
      </p>
      {sortedForDisplay.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No bands configured — every task uses benchmark-ranked selection.
        </p>
      ) : (
        <div className="space-y-3">
          {sortedForDisplay.map(({ band, index }) => (
            <div key={index} className="space-y-2 rounded-md border border-input p-2">
              <div className="flex items-center gap-2">
                <label
                  className="text-xs text-muted-foreground"
                  htmlFor={`autorouter-band-${index}-min`}
                >
                  Difficulty
                </label>
                <input
                  id={`autorouter-band-${index}-min`}
                  type="number"
                  min={0}
                  max={100}
                  placeholder="0"
                  aria-label="Minimum difficulty (inclusive; blank = unbounded)"
                  value={boundInputValue(band.minDifficulty)}
                  className="w-16 rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onChange={(event) =>
                    updateBand(index, {
                      minDifficulty: parseBoundInput(event.target.value),
                    })
                  }
                />
                <span className="text-xs text-muted-foreground">to</span>
                <input
                  id={`autorouter-band-${index}-max`}
                  type="number"
                  min={0}
                  max={100}
                  placeholder="100"
                  aria-label="Maximum difficulty (inclusive; blank = unbounded)"
                  value={boundInputValue(band.maxDifficulty)}
                  className="w-16 rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onChange={(event) =>
                    updateBand(index, {
                      maxDifficulty: parseBoundInput(event.target.value),
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto"
                  onClick={() => removeBand(index)}
                  aria-label={`Remove the difficulty ${boundInputValue(band.minDifficulty) || "0"}-${boundInputValue(band.maxDifficulty) || "100"} band`}
                >
                  <Icon name="X" aria-hidden />
                </Button>
              </div>
              {band.fallbackChain.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  Empty — this band defers to benchmark-ranked selection.
                </p>
              ) : (
                <div className="space-y-1">
                  {band.fallbackChain.map((entry, entryIndex) => (
                    <div
                      key={`${entry}-${entryIndex}`}
                      className="flex items-center gap-2 rounded-md border border-input px-2 py-1.5 text-sm"
                    >
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {entryIndex + 1}.
                      </span>
                      <span className="flex-1 truncate">{entry}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={entryIndex === 0}
                        onClick={() =>
                          updateBand(index, {
                            fallbackChain: moveEntry(band.fallbackChain, entryIndex, entryIndex - 1),
                          })
                        }
                        aria-label={`Move ${entry} earlier`}
                      >
                        <Icon name="ArrowUp" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={entryIndex === band.fallbackChain.length - 1}
                        onClick={() =>
                          updateBand(index, {
                            fallbackChain: moveEntry(band.fallbackChain, entryIndex, entryIndex + 1),
                          })
                        }
                        aria-label={`Move ${entry} later`}
                      >
                        <Icon name="ArrowDown" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          updateBand(index, {
                            fallbackChain: band.fallbackChain.filter((_, i) => i !== entryIndex),
                          })
                        }
                        aria-label={`Remove ${entry}`}
                      >
                        <Icon name="X" aria-hidden />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <div className="overflow-hidden rounded-md border border-input">
                <Command>
                  <CommandInput placeholder="Add a model to this band's fallback chain…" />
                  <CommandList className="max-h-40">
                    <CommandEmpty>
                      {picker.status === "ready"
                        ? "No models match your search."
                        : picker.status === "failed"
                          ? "Couldn't load the model catalog."
                          : "Loading models…"}
                    </CommandEmpty>
                    {(picker.catalog?.providers ?? []).map((provider) => (
                      <CommandGroup key={provider.id} heading={provider.displayName}>
                        {provider.models.map((model) => {
                          const value = `${provider.id}/${model.model}`;
                          const alreadyAdded = band.fallbackChain.includes(value);
                          return (
                            <CommandItem
                              key={value}
                              value={value}
                              disabled={alreadyAdded}
                              keywords={[model.displayName, provider.displayName]}
                              onSelect={() =>
                                updateBand(index, {
                                  fallbackChain: [...band.fallbackChain, value],
                                })
                              }
                            >
                              <Icon name="Plus" aria-hidden />
                              <span className="truncate">{model.displayName}</span>
                              {alreadyAdded ? (
                                <span className="ml-auto text-xs text-muted-foreground">added</span>
                              ) : null}
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    ))}
                  </CommandList>
                </Command>
              </div>
            </div>
          ))}
        </div>
      )}
      <Button variant="outline" size="sm" onClick={addBand}>
        <Icon name="Plus" aria-hidden />
        Add band
      </Button>
    </div>
  );
}

function AutoRouterSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [settings, setSettings] = useState<AutorouterSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settingsRef = useRef<AutorouterSettings | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveVersionRef = useRef(0);

  // Decision-agent model picker: same pattern as bb-plugin-prompt-enhancer's
  // ModelSettingsSection — fetch the live provider/model catalog once, offer
  // a searchable list instead of a free-text "provider/model" box.
  const [picker, setPicker] = useState<CatalogState>({
    status: "loading",
    catalog: null,
  });

  useEffect(() => {
    let cancelled = false;
    void rpc
      .call("listModels")
      .then((catalog) => {
        if (!cancelled) setPicker({ status: "ready", catalog });
      })
      .catch(() => {
        if (!cancelled) setPicker({ status: "failed", catalog: null });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = () => {
    void rpc
      .call("getSettings")
      .then((next) => {
        settingsRef.current = next;
        setSettings(next);
        setError(null);
      })
      .catch((loadError) => {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load Autorouter settings",
        );
      });
  };

  useEffect(load, []);
  useRealtime("settings-changed", load);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const persist = (next: AutorouterSettings) => {
    const version = ++saveVersionRef.current;
    void rpc
      .call("updateSettings", next)
      .then((saved) => {
        if (version !== saveVersionRef.current) return;
        settingsRef.current = saved;
        setSettings(saved);
        setError(null);
      })
      .catch((saveError) => {
        if (version !== saveVersionRef.current) return;
        setError(
          saveError instanceof Error
            ? saveError.message
            : "Unable to save Autorouter settings",
        );
      });
  };

  const update = (
    patch: Partial<AutorouterSettings>,
    options: { debounceMs?: number } = {},
  ) => {
    if (!settingsRef.current) return;
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    if (options.debounceMs) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        persist(settingsRef.current ?? next);
      }, options.debounceMs);
    } else {
      timerRef.current = null;
      persist(next);
    }
  };

  const flush = () => {
    if (timerRef.current === null || !settingsRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    persist(settingsRef.current);
  };

  if (!settings) {
    return (
      <p
        className={
          error ? "text-sm text-destructive" : "text-sm text-muted-foreground"
        }
      >
        {error ?? "Loading settings…"}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <label className="flex items-start justify-between gap-4">
        <span>
          <span className="block text-sm font-medium">Enable Auto Router</span>
          <span className="block text-xs text-muted-foreground">
            Allow the extension page and CLI to create routed threads.
          </span>
        </span>
        <input
          type="checkbox"
          className="mt-1 size-4 accent-primary"
          checked={settings.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
      </label>

      <div className="space-y-2">
        <div>
          <label className="text-sm font-medium" htmlFor="autorouter-frugality">
            Frugality
          </label>
          <p className="text-xs text-muted-foreground">
            Controls how strongly cost per task influences model selection.
          </p>
        </div>
        <input
          id="autorouter-frugality"
          type="range"
          min={0}
          max={100}
          step={1}
          value={settings.frugality}
          className="w-full accent-primary"
          onChange={(event) =>
            update(
              { frugality: Number(event.target.value) },
              { debounceMs: 250 },
            )
          }
          onPointerUp={flush}
          onKeyUp={flush}
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>$</span>
          <span>{settings.frugality}%</span>
          <span>$$$</span>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="autorouter-decision-agent">
          Decision agent
        </label>
        <p className="text-xs text-muted-foreground">
          The model that rates each task's difficulty (0-100) before routing.
          <span className="font-medium text-foreground"> Automatic</span> tries
          your fallback order below, first one actually available wins. Pick a
          specific model instead to pin the classifier to it, skipping the
          fallback order entirely.
        </p>
        <div className="overflow-hidden rounded-md border border-input" id="autorouter-decision-agent">
          <Command>
            <CommandInput placeholder="Search providers and models…" />
            <CommandList className="max-h-64">
              <CommandEmpty>
                {picker.status === "ready"
                  ? "No models match your search."
                  : picker.status === "failed"
                    ? "Couldn't load the model catalog."
                    : "Loading models…"}
              </CommandEmpty>
              <CommandGroup heading="General">
                <CommandItem
                  value="automatic"
                  keywords={["default", "automatic", "cheapest", "fallback"]}
                  onSelect={() => update({ decisionAgent: "automatic" })}
                >
                  <Icon
                    name="Check"
                    className={settings.decisionAgent === "automatic" ? undefined : "invisible"}
                    aria-hidden
                  />
                  <span className="truncate">Automatic (use fallback order below)</span>
                  <span className="ml-auto text-xs text-muted-foreground">default</span>
                </CommandItem>
              </CommandGroup>
              {(picker.catalog?.providers ?? []).map((provider) => (
                <CommandGroup key={provider.id} heading={provider.displayName}>
                  {provider.models.map((model) => {
                    const value = `${provider.id}/${model.model}`;
                    const isAutomatic = settings.decisionAgent === "automatic";
                    const isChecked = isAutomatic
                      ? settings.automaticFallbackChain.includes(value)
                      : settings.decisionAgent === value;
                    return (
                      <CommandItem
                        key={value}
                        value={value}
                        keywords={[model.displayName, provider.displayName]}
                        onSelect={() => {
                          if (isAutomatic) {
                            // In Automatic mode, this single control doubles
                            // as the fallback-order editor: selecting a
                            // model toggles its membership in the ordered
                            // chain instead of pinning the classifier to it.
                            update({
                              automaticFallbackChain: isChecked
                                ? settings.automaticFallbackChain.filter(
                                    (entry) => entry !== value,
                                  )
                                : [...settings.automaticFallbackChain, value],
                            });
                          } else {
                            update({ decisionAgent: value });
                          }
                        }}
                      >
                        <Icon name="Check" className={isChecked ? undefined : "invisible"} aria-hidden />
                        <span className="truncate">{model.displayName}</span>
                        {model.isDefault ? (
                          <span className="ml-auto text-xs text-muted-foreground">default</span>
                        ) : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </div>
        {settings.decisionAgent === "automatic" ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              Fallback order — tried top to bottom, first available and
              quota-eligible wins. Check items above to add or remove them;
              reorder with the arrows. Not opinionated by default: this is a
              plain, editable list, not a fixed rule. Empty, or if none of
              these are available, falls back to any launchable model as a
              last resort.
            </p>
            {settings.automaticFallbackChain.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                Empty — automatic mode goes straight to the last-resort fallback.
              </p>
            ) : (
              <div className="space-y-1">
                {settings.automaticFallbackChain.map((entry, index) => (
                  <div
                    key={`${entry}-${index}`}
                    className="flex items-center gap-2 rounded-md border border-input px-2 py-1.5 text-sm"
                  >
                    <span className="text-xs text-muted-foreground tabular-nums">{index + 1}.</span>
                    <span className="flex-1 truncate">{entry}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={index === 0}
                      onClick={() =>
                        update({
                          automaticFallbackChain: moveEntry(
                            settings.automaticFallbackChain,
                            index,
                            index - 1,
                          ),
                        })
                      }
                      aria-label={`Move ${entry} earlier`}
                    >
                      <Icon name="ArrowUp" aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={index === settings.automaticFallbackChain.length - 1}
                      onClick={() =>
                        update({
                          automaticFallbackChain: moveEntry(
                            settings.automaticFallbackChain,
                            index,
                            index + 1,
                          ),
                        })
                      }
                      aria-label={`Move ${entry} later`}
                    >
                      <Icon name="ArrowDown" aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        update({
                          automaticFallbackChain: settings.automaticFallbackChain.filter(
                            (_, i) => i !== index,
                          ),
                        })
                      }
                      aria-label={`Remove ${entry}`}
                    >
                      <Icon name="X" aria-hidden />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Pinned: <span className="font-medium text-foreground">{settings.decisionAgent}</span>
          </p>
        )}
      </div>

      <DifficultyBandsSection settings={settings} update={update} picker={picker} />

      <div className="space-y-2">
        <label
          className="text-sm font-medium"
          htmlFor="autorouter-instructions"
        >
          Custom instructions
        </label>
        <textarea
          id="autorouter-instructions"
          rows={6}
          maxLength={12_000}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={settings.customInstructions}
          placeholder="For example: rate authentication and production migrations at least 85. Route CSS-only changes to Composer 2.5."
          onChange={(event) =>
            update(
              { customInstructions: event.target.value },
              { debounceMs: 500 },
            )
          }
          onBlur={flush}
        />
        <p className="text-xs text-muted-foreground">
          These instructions may name a model override. The classifier cannot
          invent one; the requested name must also be grounded in the prompt or
          these instructions.
        </p>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "autorouter",
    title: "New autorouter thread",
    icon: "Workflow",
    path: "autorouter",
    component: AutoRouterPage,
  });
  app.slots.settingsSection({
    id: "autorouter-settings",
    title: "Routing policy",
    description:
      "Configure task classification and the cost-to-capability tradeoff.",
    component: AutoRouterSettings,
  });
});
