import { describe, expect, it } from "vitest";
import { defaultAutorouterSettings, parseStoredSettings } from "./settings.js";

describe("parseStoredSettings migration", () => {
  it("returns stored settings unchanged when they already match the current schema", () => {
    const stored = {
      ...defaultAutorouterSettings,
      decisionAgent: "antigravity/gemini-3.7-flash-high",
    };
    expect(parseStoredSettings(stored)).toEqual(stored);
  });

  it("preserves a user override when a new top-level field was added since it was stored", () => {
    // Reproduces a real regression hit live: settings stored before
    // automaticFallbackChain existed used to get wholesale reset to
    // defaultAutorouterSettings on the next load, silently discarding
    // decisionAgent along with it.
    const legacyStored = {
      enabled: true,
      decisionAgent: "antigravity/gemini-3.7-flash-high",
      customInstructions: "Route CSS-only work to Antigravity.",
      frugality: 50,
      // automaticFallbackChain and difficultyBands intentionally absent.
    };
    const result = parseStoredSettings(legacyStored);
    expect(result.decisionAgent).toBe("antigravity/gemini-3.7-flash-high");
    expect(result.customInstructions).toBe("Route CSS-only work to Antigravity.");
    expect(result.automaticFallbackChain).toEqual(
      defaultAutorouterSettings.automaticFallbackChain,
    );
    expect(result.difficultyBands).toEqual(defaultAutorouterSettings.difficultyBands);
  });

  it("migrates the oldest pre-comparator band shape (implicit <=) into a range", () => {
    const legacyStored = {
      ...defaultAutorouterSettings,
      difficultyBands: [
        // Oldest shape: no `comparator`, no `minDifficulty` at all.
        { maxDifficulty: 40, fallbackChain: ["codex/gpt-5.6-luna"] },
      ],
    };
    const result = parseStoredSettings(legacyStored);
    expect(result.difficultyBands).toEqual([
      { minDifficulty: null, maxDifficulty: 40, fallbackChain: ["codex/gpt-5.6-luna"] },
    ]);
  });

  it("migrates each comparator variant from the intermediate shape into an equivalent range", () => {
    const legacyStored = {
      ...defaultAutorouterSettings,
      difficultyBands: [
        { maxDifficulty: 25, comparator: "<=", fallbackChain: ["a"] },
        { maxDifficulty: 25, comparator: "<", fallbackChain: ["b"] },
        { maxDifficulty: 75, comparator: ">=", fallbackChain: ["c"] },
        { maxDifficulty: 75, comparator: ">", fallbackChain: ["d"] },
        { maxDifficulty: 50, comparator: "==", fallbackChain: ["e"] },
      ],
    };
    const result = parseStoredSettings(legacyStored);
    expect(result.difficultyBands).toEqual([
      { minDifficulty: null, maxDifficulty: 25, fallbackChain: ["a"] },
      { minDifficulty: null, maxDifficulty: 24, fallbackChain: ["b"] },
      { minDifficulty: 75, maxDifficulty: null, fallbackChain: ["c"] },
      { minDifficulty: 76, maxDifficulty: null, fallbackChain: ["d"] },
      { minDifficulty: 50, maxDifficulty: 50, fallbackChain: ["e"] },
    ]);
  });

  it("leaves a band already in the current range shape alone during migration", () => {
    const legacyStored = {
      ...defaultAutorouterSettings,
      difficultyBands: [
        { minDifficulty: 26, maxDifficulty: 75, fallbackChain: ["codex/gpt-5.6-terra"] },
      ],
    };
    const result = parseStoredSettings(legacyStored);
    expect(result.difficultyBands).toEqual([
      { minDifficulty: 26, maxDifficulty: 75, fallbackChain: ["codex/gpt-5.6-terra"] },
    ]);
  });

  it("falls back to full defaults only for genuinely unparseable data", () => {
    expect(parseStoredSettings(null)).toEqual(defaultAutorouterSettings);
    expect(parseStoredSettings("not an object")).toEqual(defaultAutorouterSettings);
    expect(parseStoredSettings({ enabled: "not a boolean" })).toEqual(
      defaultAutorouterSettings,
    );
  });
});
