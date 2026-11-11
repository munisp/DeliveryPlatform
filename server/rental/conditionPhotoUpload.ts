import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type express from "express";
import { Pool } from "pg";

import { ENV } from "../_core/env";
import { recordOperationalEvent } from "../_core/operationalEvents";
import type { SessionUser } from "../_core/trpc";

/**
 * Rental condition photo upload (POST /api/rental-condition/photo) and
 * download (GET /api/rental-condition/photo/<objectKey>).
 *
 * The mobile app captures check-out / check-in evidence photos, encodes them
 * as base64 JSON and posts them here. The upload handler is a thin adapter;
 * all validation and storage semantics live in storeConditionPhoto so they
 * can be unit-tested without Express.
 *
 * The download handler streams a previously stored photo back to a contract
 * party (the PWA renders it via same-origin <img>). The object key is
 * extracted from the wildcard path, validated against the exact same strict
 * key pattern used at upload time, and resolved inside
 * ENV.rentalConditionUploadDir with traversal defenses; resolution semantics
 * live in resolveConditionPhotoPath so they can be unit-tested without
 * Express. Responses are private-cached for one hour and served inline with
 * a nosniff content type derived from the key extension.
 *
 * Download authorization (P2 closure): the key's second path segment is the
 * contract id; the caller must be a party to that contract — the renter
 * (access_contract.worker_user_id) or an operator — as decided by the
 * SECURITY DEFINER vehicle_access.can_view_contract_evidence (drizzle/0101).
 * Upload authorization (which contract party may attach which evidence) is
 * enforced downstream by the vehicle_access.record_condition_report SQL
 * function when the stored object key is linked to a contract.
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

// Own satellite pool (mirrors server/_core/vehicleCondition.ts): the download
// gate queries vehicle_access.can_view_contract_evidence per request, so it
// shares the "vehicle-condition" application_name and the same hard caps —
// evidence reads must not starve the primary vehicle_access pool.
let pool: Pool | null = null;

function database() {
  if (!ENV.databaseUrl)
    throw new Error("vehicle_condition_database_unconfigured");
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      application_name: "vehicle-condition",
      ssl:
        ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable")
          ? {
              rejectUnauthorized: true,
              ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}),
            }
          : false,
      // Hard-capped like every other satellite pool (perf finding 10).
      max: 3,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      options: "-c statement_timeout=10000",
    });
  }
  return pool;
}

/**
 * Party gate for condition-photo downloads (drizzle/0101): true iff the
 * actor is an operator or the renter (worker_user_id) of the contract the
 * photo belongs to. Kept separate from the Express handler so it can be
 * unit-tested with a mocked pool.
 */
export async function canViewConditionPhoto(
  actorId: number,
  contractId: string,
): Promise<boolean> {
  const result = await database().query<{ allowed: boolean }>(
    `SELECT vehicle_access.can_view_contract_evidence($1,$2::uuid) AS allowed`,
    [actorId, contractId],
  );
  return result.rows[0]?.allowed === true;
}

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

export type ResolveConditionPhotoResult =
  | {
      status: 200;
      path: string;
      contentType: string;
      sizeBytes: number;
    }
  | {
      status: 400 | 404 | 503;
      error:
        | "invalid_object_key"
        | "photo_not_found"
        | "photo_storage_not_configured";
    };

/**
 * Resolve a validated condition-photo object key to a file inside the
 * configured upload root. Fail-closed: no root means 503, a key that does
 * not match the strict upload-time shape (or that escapes the root) means
 * 400, and a missing object means 404.
 */
export async function resolveConditionPhotoPath(
  root: unknown,
  objectKey: unknown,
): Promise<ResolveConditionPhotoResult> {
  const trimmedRoot = typeof root === "string" ? root.trim() : "";
  if (!trimmedRoot) {
    return { status: 503, error: "photo_storage_not_configured" };
  }
  if (!isValidConditionPhotoObjectKey(objectKey)) {
    return { status: 400, error: "invalid_object_key" };
  }
  const resolvedRoot = path.resolve(trimmedRoot);
  const targetPath = path.join(resolvedRoot, objectKey);
  if (!targetPath.startsWith(resolvedRoot + path.sep)) {
    return { status: 400, error: "invalid_object_key" };
  }
  const extension = objectKey.split(".").pop()?.toLowerCase() ?? "";
  const contentType = CONTENT_TYPE_BY_EXTENSION[extension];
  if (!contentType) {
    return { status: 400, error: "invalid_object_key" };
  }
  let sizeBytes: number;
  try {
    const info = await stat(targetPath);
    if (!info.isFile()) {
      return { status: 404, error: "photo_not_found" };
    }
    sizeBytes = info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: 404, error: "photo_not_found" };
    }
    throw error;
  }
  return { status: 200, path: targetPath, contentType, sizeBytes };
}

export type VerifyConditionPhotoEvidenceResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "photo_storage_not_configured"
        | "evidence_not_uploaded"
        | "evidence_hash_mismatch";
    };

/**
 * Server-side verification of a client-claimed evidence hash (P2 closure):
 * the object must exist under the configured upload root and the sha256 of
 * the stored bytes must equal the claim. Fail-closed when no upload root is
 * configured — photos cannot have been uploaded through our endpoint, so
 * claims are unverifiable. Callers must pre-filter with
 * isValidConditionPhotoObjectKey; keys outside our namespace belong to
 * external object stores and are out of scope for this check.
 */
export async function verifyConditionPhotoEvidence(
  root: unknown,
  objectKey: string,
  sha256Hex: string,
): Promise<VerifyConditionPhotoEvidenceResult> {
  const resolved = await resolveConditionPhotoPath(root, objectKey);
  if (resolved.status === 503) {
    return { ok: false, error: "photo_storage_not_configured" };
  }
  if (resolved.status !== 200) {
    return { ok: false, error: "evidence_not_uploaded" };
  }
  const bytes = await readFile(resolved.path);
  const actualSha256Hex = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256Hex !== sha256Hex) {
    return { ok: false, error: "evidence_hash_mismatch" };
  }
  return { ok: true };
}

export async function handleRentalConditionPhotoDownload(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  try {
    // Same session middleware contract as the upload route: req.user is
    // populated for every /api/* path.
    const user = (
      req as express.Request & { user?: SessionUser | null }
    ).user;
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    // Express wildcard params are positional: params[0] is everything after
    // "/api/rental-condition/photo/".
    const params = (req.params ?? {}) as Record<string, unknown>;
    const objectKey = typeof params["0"] === "string" ? params["0"] : "";
    if (!isValidConditionPhotoObjectKey(objectKey)) {
      res.status(400).json({ error: "invalid_object_key" });
      return;
    }
    // Storage must be configured before anything else (fail closed, same
    // contract as resolveConditionPhotoPath) so the gate below never runs
    // against a deployment that cannot serve evidence anyway.
    if (!ENV.rentalConditionUploadDir.trim()) {
      res.status(503).json({ error: "photo_storage_not_configured" });
      return;
    }
    // Party gate (P2): the key's second segment is the contract id; only the
    // contract renter or an operator may read the evidence. A gate failure
    // (e.g. database unreachable) fails closed as a 500 — never serve.
    const contractId = objectKey.split("/")[1] ?? "";
    let allowed: boolean;
    try {
      allowed = await canViewConditionPhoto(user.id, contractId);
    } catch (gateError) {
      console.error(
        "[SwitchOS] Rental condition photo access check failed",
        gateError,
      );
      res.status(500).json({ error: "photo_access_check_failed" });
      return;
    }
    if (!allowed) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const resolved = await resolveConditionPhotoPath(
      ENV.rentalConditionUploadDir,
      objectKey,
    );
    if (resolved.status !== 200) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    res.setHeader("Content-Type", resolved.contentType);
    res.setHeader("Content-Length", resolved.sizeBytes);
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const stream = createReadStream(resolved.path);
    stream.on("error", (streamError) => {
      console.error(
        "[SwitchOS] Rental condition photo stream failed",
        streamError,
      );
      // The file was stat'ed moments ago, so an error here means the object
      // vanished mid-serve; only a fresh response can still report it.
      if (!res.headersSent) {
        res.status(500).json({ error: "photo_read_failed" });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
    stream.pipe(res);
  } catch (error) {
    console.error("[SwitchOS] Rental condition photo download failed", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "photo_download_failed" });
    }
  }
}
