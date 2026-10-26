import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";

describe("Autorouter plugin", () => {
  it.each([
    {
      name: "empty response",
      usage: {},
      error: "BB returned an incomplete provider usage response",
    },
    {
      name: "missing providers",
      usage: { codex: { status: "expired" } },
      error: "BB returned an incomplete provider usage response",
    },
    {
      name: "mixed incomplete formats",
      usage: {
        codex: { status: "expired" },
        "claude-code": { status: "unauthenticated" },
        cursor: { status: "not_installed" },
      },
      error: "BB returned an incomplete provider usage response",
    },
    {
      name: "complete legacy response with no models",
      usage: {
        codex: { status: "not_installed" },
        claudeCode: { status: "not_installed" },
        cursor: { status: "not_installed" },
      },
      error: "Autorouter found no available provider model",
    },
    {
      name: "complete provider-keyed response with no models",
      usage: {
        codex: { status: "not_installed" },
        "claude-code": { status: "not_installed" },
        "acp-cursor": { status: "not_installed" },
      },
      error: "Autorouter found no available provider model",
    },
  ])("reports the routing error for $name", async ({ usage, error }) => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "autorouter",
      sdk: {
        providers: { list: async () => [] },
        system: { usageLimits: async () => usage },
      },
    });
    await plugin(bb);
    try {
      await expect(
        harness.behavior.callRpc("createThread", {
          request: {
            projectId: "project-test",
            environment: { type: "project-default" },
            providerId: "codex",
            model: "gpt-5.6-luna",
            reasoningLevel: "low",
            permissionMode: "accept-edits",
            input: [{ type: "text", text: "Test", mentions: [] }],
          },
        }),
      ).rejects.toThrow(error);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("registers RPC and autosaved settings storage", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "autorouter" });
    await plugin(bb);

    expect(await harness.behavior.callRpc("getSettings", null)).toMatchObject({
      enabled: true,
      frugality: 50,
      decisionAgent: "automatic",
    });
    expect(
      await harness.behavior.callRpc("updateSettings", { frugality: 75 }),
    ).toMatchObject({ frugality: 75 });
    expect(await harness.behavior.callRpc("getSettings", null)).toMatchObject({
      frugality: 75,
    });
    expect(harness.inspection.registrations.cli?.name).toBe("autorouter");

    await harness.lifecycle.dispose();
  });
});
