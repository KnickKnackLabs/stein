import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

type ModelRuntimeOptions = NonNullable<Parameters<typeof ModelRuntime.create>[0]>;
type CredentialStore = NonNullable<ModelRuntimeOptions["credentials"]>;
type ModelsStore = NonNullable<ModelRuntimeOptions["modelsStore"]>;
type ModelsStoreEntry = Awaited<ReturnType<ModelsStore["read"]>>;

function inMemoryPiModelsStore(): ModelsStore {
  const entries = new Map<string, ModelsStoreEntry>();
  return {
    async read(providerId) {
      return entries.get(providerId);
    },
    async write(providerId, entry) {
      entries.set(providerId, entry);
    },
    async delete(providerId) {
      entries.delete(providerId);
    },
  };
}

export async function createReadOnlyPiModelRuntime(
  agentDirectory: string,
  provider: string,
): Promise<ModelRuntime> {
  const credentials = await readOnlyPiApiKeyCredentials(
    join(agentDirectory, "auth.json"),
    provider,
  );
  return ModelRuntime.create({
    credentials,
    modelsPath: join(agentDirectory, "models.json"),
    modelsStore: inMemoryPiModelsStore(),
    allowModelNetwork: false,
  });
}

export async function readOnlyPiApiKeyCredentials(
  authPath: string,
  provider: string,
): Promise<CredentialStore> {
  const parsed: unknown = JSON.parse(await readFile(authPath, "utf8"));
  if (!isRecord(parsed)) throw new Error("Pi auth file must contain an object");

  const stored = parsed[provider];
  if (
    !isRecord(stored) ||
    stored.type !== "api_key" ||
    typeof stored.key !== "string" ||
    stored.key.length === 0
  ) {
    throw new Error(`Pi auth file has no static API key for provider: ${provider}`);
  }

  const credential = Object.freeze({ type: "api_key" as const, key: stored.key });
  return {
    async read(providerId) {
      return providerId === provider ? credential : undefined;
    },
    async list() {
      return [{ providerId: provider, type: credential.type }];
    },
    async modify() {
      throw new Error("Pi credentials are read-only");
    },
    async delete() {
      throw new Error("Pi credentials are read-only");
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
