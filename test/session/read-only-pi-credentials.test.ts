import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReadOnlyPiModelRuntime,
  readOnlyPiApiKeyCredentials,
} from "../../src/session/read-only-pi-credentials.ts";

const roots: Array<{ root: string; agentDirectory: string }> = [];
const provider = "test-local";
const modelId = "deterministic";

const models = {
  providers: {
    [provider]: {
      name: "Test local",
      baseUrl: "http://127.0.0.1:8080/v1",
      api: "openai-completions",
      authHeader: true,
      models: [{
        id: modelId,
        name: "Deterministic",
        reasoning: false,
        input: ["text"],
        contextWindow: 4096,
        maxTokens: 256,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async ({ root, agentDirectory }) => {
    await chmod(agentDirectory, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }));
});

async function piAgentDirectory(
  readOnly: boolean,
  auth: unknown = { [provider]: { type: "api_key", key: "fictional-api-key" } },
): Promise<{ agentDirectory: string; authPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "stein-read-only-pi-auth-"));
  const agentDirectory = join(root, "pi");
  await mkdir(agentDirectory, { mode: 0o700 });
  roots.push({ root, agentDirectory });

  const authPath = join(agentDirectory, "auth.json");
  const modelsPath = join(agentDirectory, "models.json");
  await writeFile(authPath, `${JSON.stringify(auth)}\n`, { mode: 0o400 });
  await writeFile(modelsPath, `${JSON.stringify(models)}\n`, { mode: 0o400 });
  if (readOnly) await chmod(agentDirectory, 0o500);
  return { agentDirectory, authPath };
}

describe("read-only Pi credentials", () => {
  test("authenticates a configured model without locking or writing the auth directory", async () => {
    const fixture = await piAgentDirectory(true);
    const runtime = await createReadOnlyPiModelRuntime(fixture.agentDirectory, provider);

    expect(runtime.getModel(provider, modelId)).toBeDefined();
    expect(runtime.hasConfiguredAuth(provider)).toBeTrue();
    expect((await runtime.checkAuth(provider))?.type).toBe("api_key");
    expect((await runtime.getAuth(provider))?.auth.apiKey).toBe("fictional-api-key");
    expect((await readdir(fixture.agentDirectory)).sort()).toEqual(["auth.json", "models.json"]);
  });

  test("does not create a model catalog sidecar in a writable config directory", async () => {
    const fixture = await piAgentDirectory(false);
    await createReadOnlyPiModelRuntime(fixture.agentDirectory, provider);

    expect((await readdir(fixture.agentDirectory)).sort()).toEqual(["auth.json", "models.json"]);
  });

  test("lists only credential metadata and rejects mutation", async () => {
    const fixture = await piAgentDirectory(true);
    const credentials = await readOnlyPiApiKeyCredentials(fixture.authPath, provider);

    expect(await credentials.list()).toEqual([{ providerId: provider, type: "api_key" }]);
    expect(await credentials.read(provider)).toEqual({
      type: "api_key",
      key: "fictional-api-key",
    });
    expect(await credentials.read("other-provider")).toBeUndefined();
    await expect(credentials.modify(provider, async () => undefined))
      .rejects.toThrow("read-only");
    await expect(credentials.delete(provider)).rejects.toThrow("read-only");
  });

  test("fails closed when the exact provider has no static API key", async () => {
    const missing = await piAgentDirectory(true, {
      "other-provider": { type: "api_key", key: "fictional-other-key" },
    });
    await expect(readOnlyPiApiKeyCredentials(missing.authPath, provider))
      .rejects.toThrow(`no static API key for provider: ${provider}`);

    const dynamic = await piAgentDirectory(true, {
      [provider]: { type: "api_key", key: { command: "ambient-fallback" } },
    });
    await expect(readOnlyPiApiKeyCredentials(dynamic.authPath, provider))
      .rejects.toThrow(`no static API key for provider: ${provider}`);
  });
});
