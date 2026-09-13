import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ENV } from "./_core/env";

function storageConfig() {
  if (
    !ENV.objectStorageEndpoint ||
    !ENV.objectStorageBucket ||
    !ENV.objectStorageAccessKeyId ||
    !ENV.objectStorageSecretAccessKey
  ) {
    throw new Error(
      "Object storage config missing: set OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_ACCESS_KEY_ID, and OBJECT_STORAGE_SECRET_ACCESS_KEY",
    );
  }

  return {
    endpoint: ENV.objectStorageEndpoint,
    bucket: ENV.objectStorageBucket,
    region: ENV.objectStorageRegion,
    forcePathStyle: ENV.objectStorageForcePathStyle,
    credentials: {
      accessKeyId: ENV.objectStorageAccessKeyId,
      secretAccessKey: ENV.objectStorageSecretAccessKey,
    },
  };
}

function client() {
  const config = storageConfig();
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: config.credentials,
  });
}

function bucket() {
  return storageConfig().bucket;
}

function normalizeKey(relKey: string): string {
  const key = relKey.replace(/^\/+/, "");
  if (!key || key.split("/").some((segment) => segment === "..")) {
    throw new Error("invalid_object_storage_key");
  }
  return key;
}

function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  const key = appendHashSuffix(normalizeKey(relKey));
  await client().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: data,
      ContentType: contentType,
      CacheControl: "private, no-store",
    }),
  );
  return { key, url: `/storage/${encodeURIComponent(key)}` };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: `/storage/${encodeURIComponent(key)}` };
}

export async function storageGetSignedUrl(relKey: string): Promise<string> {
  const key = normalizeKey(relKey);
  return getSignedUrl(
    client(),
    new GetObjectCommand({ Bucket: bucket(), Key: key, ResponseCacheControl: "private, no-store" }),
    { expiresIn: 300 },
  );
}
