export type PodUploadAuthorization = { uploadUrl: string; headers: Record<string, string>; expiresAt: string };

/**
 * Production deployments replace this adapter with their S3-compatible signer.
 * Deliberately returns no authorization until all storage credentials are configured.
 */
export function authorizePodUpload(input: { tenantId: number; objectKey: string; contentType: string; maxBytes: number }): PodUploadAuthorization {
  const endpoint = process.env.POD_STORAGE_ENDPOINT?.trim();
  const bucket = process.env.POD_STORAGE_BUCKET?.trim();
  const accessKey = process.env.POD_STORAGE_ACCESS_KEY?.trim();
  const secret = process.env.POD_STORAGE_SECRET_KEY?.trim();
  if (!endpoint || !bucket || !accessKey || !secret) throw new Error("pod_storage_unconfigured");
  if (!endpoint.startsWith("https://") || !input.objectKey.startsWith(`tenant/${input.tenantId}/`)) throw new Error("pod_storage_authorization_invalid");
  // Signing belongs to the configured provider adapter; never manufacture a usable URL.
  throw new Error("pod_storage_signer_not_installed");
}
