import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type express from "express";

import { ENV } from "../_core/env";
import { recordOperationalEvent } from "../_core/operationalEvents";
import type { SessionUser } from "../_core/trpc";

/**
 * Rental condition photo upload (POST /api/rental-condition/photo).
 *
 * The mobile app captures check-out / check-in evidence photos, encodes them
 * as base64 JSON and posts them here. The handler is a thin adapter; all
 * validation and storage semantics live in storeConditionPhoto so they can
 * be unit-tested without Express.
 *
 * Authorization (which contract party may read or attach which evidence) is
 * enforced downstream by the vehicle_access.record_condition_report SQL
 * function when the stored object key is linked to a contract; this endpoint
 * only requires an authenticated session.
 */

export const CONDITION_PHOTO_MAX_BYTES = 6_000_000;

const CONDITION_PHOTO_OBJECT_KEY_PATTERN =
  /^rental-condition\/[0-9a-fA-F-]{36}\/(check_out|check_in)\/[a-z_]{2,32}-[0-9a-f]{16}\.(jpg|jpeg|png|webp)$/;

const ALLOWED_CONDITION_PHOTO_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

// Strict RFC 4648 alphabet with padding only at the end; kept free of nested
// quantifiers so multi-megabyte payloads validate in linear time.
const STRICT_BASE64_PATTERN = /^[A-Za-z0-9+/]*(?:=|==)?$/;

export function isValidConditionPhotoObjectKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0) return false;
  // Defensive depth on top of the strict shape: never allow traversal
  // segments, absolute paths, or platform path separators other than "/".
  if (key.includes("..") || key.startsWith("/") || key.includes("\\")) {
    return false;
  }
  return CONDITION_PHOTO_OBJECT_KEY_PATTERN.test(key);
}

export function isAllowedConditionPhotoContentType(
  contentType: unknown,
): contentType is string {
  return (
    typeof contentType === "string" &&
    ALLOWED_CONDITION_PHOTO_CONTENT_TYPES.has(contentType)
  );
}

export function conditionPhotoContentTypeMatchesKey(
  objectKey: string,
  contentType: string,
): boolean {
  const extension = objectKey.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPE_BY_EXTENSION[extension] === contentType;
}

export type ConditionPhotoDecodeResult =
  | { ok: true; bytes: Buffer; sha256Hex: string }
  | {
      ok: false;
      error: "invalid_content_type" | "invalid_content_base64" | "photo_too_large";
    };

export function decodeConditionPhotoBase64(
  contentBase64: unknown,
  contentType: unknown,
): ConditionPhotoDecodeResult {
  if (!isAllowedConditionPhotoContentType(contentType)) {
    return { ok: false, error: "invalid_content_type" };
  }
  if (
    typeof contentBase64 !== "string" ||
    contentBase64.length === 0 ||
    contentBase64.length % 4 !== 0 ||
    !STRICT_BASE64_PATTERN.test(contentBase64)
  ) {
    return { ok: false, error: "invalid_content_base64" };
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.length === 0) {
    return { ok: false, error: "invalid_content_base64" };
  }
  if (bytes.length > CONDITION_PHOTO_MAX_BYTES) {
    return { ok: false, error: "photo_too_large" };
  }
  return {
    ok: true,
    bytes,
    sha256Hex: createHash("sha256").update(bytes).digest("hex"),
  };
}

export type StoreConditionPhotoArgs = {
  root: string;
  objectKey: unknown;
  contentType: unknown;
  contentBase64: unknown;
};

export type StoreConditionPhotoResult = {
  status: number;
  body: Record<string, unknown>;
};

export async function storeConditionPhoto(
  args: StoreConditionPhotoArgs,
): Promise<StoreConditionPhotoResult> {
  const { objectKey, contentType, contentBase64 } = args;
  const root = typeof args.root === "string" ? args.root.trim() : "";
  // Fail closed: without an explicit storage root there is no safe default
  // location for evidence photos.
  if (!root) {
    return { status: 503, body: { error: "photo_storage_not_configured" } };
  }
  if (!isValidConditionPhotoObjectKey(objectKey)) {
    return { status: 400, body: { error: "invalid_object_key" } };
  }
  if (
    !isAllowedConditionPhotoContentType(contentType) ||
    !conditionPhotoContentTypeMatchesKey(objectKey, contentType)
  ) {
    return { status: 400, body: { error: "invalid_content_type" } };
  }
  const decoded = decodeConditionPhotoBase64(contentBase64, contentType);
  if (!decoded.ok) {
    return decoded.error === "photo_too_large"
      ? { status: 413, body: { error: "photo_too_large" } }
      : { status: 400, body: { error: decoded.error } };
  }

  const resolvedRoot = path.resolve(root);
  const targetPath = path.join(resolvedRoot, objectKey);
  if (!targetPath.startsWith(resolvedRoot + path.sep)) {
    return { status: 400, body: { error: "invalid_object_key" } };
  }

  const sizeBytes = decoded.bytes.length;
  const sha256Hex = decoded.sha256Hex;

  // Idempotent write: an existing object with identical content is a retry
  // and succeeds; different content under the same key is a conflict.
  try {
    const existing = await readFile(targetPath);
    const existingSha256Hex = createHash("sha256").update(existing).digest("hex");
    if (existingSha256Hex === sha256Hex) {
      return {
        status: 200,
        body: { objectKey, sha256Hex, sizeBytes: existing.length, reused: true },
      };
    }
    return { status: 409, body: { error: "object_key_conflict" } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  // Atomic publish: write to a sibling temp file, then rename so readers
  // never observe a partially written photo.
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporaryPath, decoded.bytes);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  try {
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }

  return { status: 201, body: { objectKey, sha256Hex, sizeBytes } };
}

export async function handleRentalConditionPhotoUpload(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  try {
    // The session middleware in server/_core/index.ts runs before this route
    // for every /api/* path and resolves req.user from the Authorization:
    // Bearer token (or session cookie); any authenticated role may upload.
    const user = (
      req as express.Request & { user?: SessionUser | null }
    ).user;
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await storeConditionPhoto({
      root: ENV.rentalConditionUploadDir,
      objectKey: body.objectKey,
      contentType: body.contentType,
      contentBase64: body.contentBase64,
    });
    if (result.status === 200 || result.status === 201) {
      void recordOperationalEvent({
        eventType: "rental.condition_photo_uploaded",
        actorId: `${user.id}`,
        actorRole: user.role ?? null,
        tenantId: user.tenantId ?? null,
        route: req.path,
        outcome: "success",
        payload: {
          objectKey: result.body.objectKey,
          sizeBytes: result.body.sizeBytes,
          reused: result.status === 200,
        },
      }).catch(() => {});
    }
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error("[SwitchOS] Rental condition photo upload failed", error);
    res.status(500).json({ error: "photo_upload_failed" });
  }
}
