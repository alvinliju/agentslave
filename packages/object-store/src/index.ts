import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export type StoredContentObject = {
  sha256: string;
  storageBackend: "agentslave-cas-v1" | "aeomatic-cas-v1";
  storageLocation: string;
  byteSize: number;
  contentType: string;
};

export type ContentStoreOptions = {
  root: string;
  baseUrl?: string;
};

export class ContentStore {
  constructor(private readonly options: ContentStoreOptions) {}

  async putJson(value: unknown): Promise<StoredContentObject> {
    return this.putBytes(Buffer.from(JSON.stringify(value)), "application/json", ".json");
  }

  async putBytes(
    bytes: Uint8Array,
    contentType: string,
    extension = extensionForContentType(contentType),
  ): Promise<StoredContentObject> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (this.options.baseUrl) {
      return putBytesOverHttp(this.options.baseUrl, bytes, sha256, contentType);
    }
    return putBytesLocally(this.options.root, bytes, sha256, contentType, extension);
  }

  async readBytes(sha256: string, extension = ".json"): Promise<Buffer> {
    validateDigest(sha256);
    const target = join(this.options.root, contentObjectLocation(sha256, extension));
    const bytes = await readFile(target);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== sha256) throw new Error(`Content object digest mismatch: ${sha256}`);
    return bytes;
  }
}

export function contentObjectLocation(sha256: string, extension = ".json"): string {
  validateDigest(sha256);
  if (!/^\.[a-z0-9]{1,10}$/i.test(extension)) throw new Error("Invalid object extension");
  return join("sha256", sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}${extension}`);
}

async function putBytesLocally(
  root: string,
  bytes: Uint8Array,
  sha256: string,
  contentType: string,
  extension: string,
): Promise<StoredContentObject> {
  const relative = contentObjectLocation(sha256, extension);
  const target = join(root, relative);
  const existing = await validExistingObject(target, bytes.byteLength, sha256);
  if (existing) return objectResult(sha256, relative, bytes.byteLength, contentType);

  await mkdir(dirname(target), { recursive: true });
  const tempDir = join(root, "tmp");
  await mkdir(tempDir, { recursive: true });
  const temp = join(tempDir, `${sha256}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }

  try {
    await link(temp, target);
    const directory = await open(dirname(target), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!(await validExistingObject(target, bytes.byteLength, sha256))) throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  return objectResult(sha256, relative, bytes.byteLength, contentType);
}

export async function putBytesOverHttp(
  baseUrl: string,
  bytes: Uint8Array,
  sha256: string,
  contentType: string,
): Promise<StoredContentObject> {
  validateDigest(sha256);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/objects/sha256/${sha256}`, {
    method: "PUT",
    headers: { "content-type": contentType, "content-length": String(bytes.byteLength) },
    body: Buffer.from(bytes),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`CAS write failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  const stored = await response.json() as StoredContentObject;
  if (stored.sha256 !== sha256 || stored.byteSize !== bytes.byteLength) {
    throw new Error(`CAS write response mismatch for ${sha256}`);
  }
  return stored;
}

function objectResult(
  sha256: string,
  storageLocation: string,
  byteSize: number,
  contentType: string,
): StoredContentObject {
  return { sha256, storageBackend: "agentslave-cas-v1", storageLocation, byteSize, contentType };
}

function validateDigest(digest: string): void {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Invalid SHA-256 digest");
}

async function validExistingObject(
  path: string,
  expectedSize: number,
  expectedDigest: string,
): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size !== expectedSize) return false;
    const bytes = await readFile(path);
    return createHash("sha256").update(bytes).digest("hex") === expectedDigest;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function extensionForContentType(contentType: string): string {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase();
  const extensions: Record<string, string> = {
    "application/json": ".json",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "text/plain": ".txt",
  };
  return extensions[normalized ?? ""] ?? ".bin";
}
