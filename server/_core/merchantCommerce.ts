import { createHash, randomBytes, randomUUID } from "crypto";
import { Pool } from "pg";

import { ENV } from "./env";
import { resilientFetch } from "./resilientFetch";

let pool: Pool | null = null;

function database() {
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl:
        ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable")
          ? {
              rejectUnauthorized: true,
              ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}),
            }
          : false,
      max: 6,
    });
  }
  return pool;
}

export class MerchantCommerceError extends Error {}

type MerchantContext = {
  provider_id: number;
  medusa_store_id: string;
  default_stock_location_id: string | null;
  payment_enabled: boolean;
  settlement_fsp_alias: string | null;
  currency_code: string | null;
};

async function authorize(
  actorUserId: number,
  providerId: number,
  roles: string[],
): Promise<MerchantContext> {
  const result = await database().query<MerchantContext>(
    `SELECT * FROM commerce.authorize_merchant_portal(
       $1,$2,$3::commerce.merchant_access_role[]
     )`,
    [actorUserId, providerId, roles],
  );
  if (result.rows.length !== 1) {
    throw new MerchantCommerceError("merchant_portal_authorization_failed");
  }
  return result.rows[0];
}

function medusaUrl(path: string) {
  if (!ENV.medusaMerchantApiUrl || !ENV.medusaMerchantApiToken) {
    throw new MerchantCommerceError("medusa_merchant_gateway_unconfigured");
  }
  return `${ENV.medusaMerchantApiUrl}${path}`;
}

async function medusaRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await resilientFetch(medusaUrl(path), {
    ...init,
    headers: {
      Authorization: `Basic ${ENV.medusaMerchantApiToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `${init.headers instanceof Headers ? init.headers.get("Idempotency-Key") ?? "" : ""}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new MerchantCommerceError(
      `medusa_merchant_gateway_${response.status}:${body.slice(0, 500)}`,
    );
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new MerchantCommerceError("medusa_merchant_gateway_invalid_json");
  }
}

function idempotencyHeader(idempotencyKey: string) {
  return { "Idempotency-Key": idempotencyKey };
}

export async function beginMerchantOnboarding(input: {
  actorUserId: number;
  providerId: number;
  legalName: string;
  displayName: string;
  medusaStoreId: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: string }>(
    `SELECT commerce.begin_merchant_onboarding($1,$2,$3,$4,$5,$6) AS state`,
    [
      input.actorUserId,
      input.providerId,
      input.legalName,
      input.displayName,
      input.medusaStoreId,
      input.idempotencyKey,
    ],
  );
  return { state: result.rows[0]?.state ?? "unknown" };
}

export async function decideMerchantOnboarding(input: {
  actorUserId: number;
  providerId: number;
  decision: "activate" | "suspend" | "reject";
  verificationCaseId?: string | null;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: string }>(
    `SELECT commerce.decide_merchant_onboarding($1,$2,$3,$4::uuid,$5) AS state`,
    [
      input.actorUserId,
      input.providerId,
      input.decision,
      input.verificationCaseId ?? null,
      input.idempotencyKey,
    ],
  );
  return { state: result.rows[0]?.state ?? "unknown" };
}

export async function getMerchantCommerceProfile(input: {
  actorUserId: number;
  providerId: number;
}) {
  const context = await authorize(input.actorUserId, input.providerId, [
    "owner",
    "catalog_manager",
    "inventory_manager",
    "finance_viewer",
  ]);
  const rows = await database().query<{
    state: string;
    display_name: string;
    legal_name: string;
    default_stock_location_id: string | null;
    product_count: string;
  }>(
    `SELECT p.state::text,p.display_name,p.legal_name,p.default_stock_location_id,
            (SELECT count(*)::text FROM commerce.merchant_catalog_product c WHERE c.provider_id=p.provider_id) AS product_count
       FROM commerce.merchant_portal p WHERE p.provider_id=$1`,
    [input.providerId],
  );
  return { ...context, ...(rows.rows[0] ?? {}), productCount: Number(rows.rows[0]?.product_count ?? 0) };
}

export async function createMerchantProduct(input: {
  actorUserId: number;
  providerId: number;
  title: string;
  handle: string;
  description: string;
  status: "draft" | "published";
  currencyCode: string;
  priceMinor: number;
  sku: string;
  imageUrls: string[];
  idempotencyKey: string;
}) {
  const context = await authorize(input.actorUserId, input.providerId, [
    "owner",
    "catalog_manager",
  ]);
  const product = await medusaRequest<{ product?: { id?: string; handle?: string } }>(
    "/admin/products",
    {
      method: "POST",
      headers: idempotencyHeader(input.idempotencyKey),
      body: JSON.stringify({
        title: input.title,
        handle: input.handle,
        description: input.description,
        status: input.status,
        images: input.imageUrls.map((url) => ({ url })),
        variants: [
          {
            title: "Default",
            sku: input.sku,
            prices: [{ currency_code: input.currencyCode.toLowerCase(), amount: input.priceMinor }],
          },
        ],
        metadata: {
          deliveryplatform_provider_id: `${context.provider_id}`,
          deliveryplatform_medusa_store_id: context.medusa_store_id,
        },
      }),
    },
  );
  const productId = product.product?.id;
  const productHandle = product.product?.handle;
  if (!productId || !productHandle) {
    throw new MerchantCommerceError("medusa_product_create_response_invalid");
  }
  await database().query(
    `SELECT commerce.record_merchant_catalog_product($1,$2,$3,$4,$5,$6)`,
    [
      input.actorUserId,
      input.providerId,
      productId,
      productHandle,
      input.status,
      input.idempotencyKey,
    ],
  );
  return { productId, handle: productHandle, state: input.status };
}

export async function setMerchantPaymentConfiguration(input: {
  actorUserId: number;
  providerId: number;
  settlementFspAlias: string;
  payoutReference: string;
  currencyCode: string;
  enabled: boolean;
  idempotencyKey: string;
}) {
  const digest = createHash("sha256").update(input.payoutReference, "utf8").digest();
  await database().query(
    `SELECT commerce.configure_merchant_payment($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.actorUserId,
      input.providerId,
      input.settlementFspAlias,
      digest,
      input.currencyCode,
      input.enabled,
      input.idempotencyKey,
    ],
  );
  return {
    paymentProvider: "deliveryplatform",
    enabled: input.enabled,
    currencyCode: input.currencyCode,
  };
}

export async function updateMerchantInventoryLevel(input: {
  actorUserId: number;
  providerId: number;
  inventoryItemId: string;
  locationId: string;
  inventoryLevelId?: string;
  stockedQuantity: number;
  incomingQuantity: number;
  idempotencyKey: string;
}) {
  await authorize(input.actorUserId, input.providerId, [
    "owner",
    "inventory_manager",
  ]);
  const response = await medusaRequest<{ inventory_item?: { id?: string } }>(
    `/admin/inventory-items/${encodeURIComponent(input.inventoryItemId)}/location-levels/${encodeURIComponent(input.locationId)}`,
    {
      method: "POST",
      headers: idempotencyHeader(input.idempotencyKey),
      body: JSON.stringify({
        ...(input.inventoryLevelId ? { id: input.inventoryLevelId } : {}),
        stocked_quantity: input.stockedQuantity,
        incoming_quantity: input.incomingQuantity,
      }),
    },
  );
  if (!response.inventory_item?.id) {
    throw new MerchantCommerceError("medusa_inventory_update_response_invalid");
  }
  return { inventoryItemId: response.inventory_item.id };
}

function credentialDigest(secret: string) {
  return createHash("sha256").update(secret).digest();
}
function credentialKeyId() {
  return `mck_${randomUUID().replaceAll("-", "")}`;
}
function credentialSecret() {
  return `mcs_${randomBytes(32).toString("base64url")}`;
}
export async function issueMerchantApiCredential(input: { actorUserId:number; providerId:number; scopes:("catalog:write"|"inventory:write"|"fulfillment:read"|"tracking:read")[]; expiresAt:string }) {
  if (!Array.isArray(input.scopes) || input.scopes.length < 1 || input.scopes.length > 8 || !Number.isFinite(Date.parse(input.expiresAt))) throw new MerchantCommerceError("merchant_credential_input_invalid");
  const keyId=credentialKeyId(), secret=credentialSecret();
  const r=await database().query<{id:string}>("SELECT commerce.issue_merchant_api_credential($1,$2,$3,$4,$5::text[],$6::timestamptz) AS id",[input.actorUserId,input.providerId,keyId,credentialDigest(secret),input.scopes,input.expiresAt]);
  return { credentialId:r.rows[0]?.id ?? null,keyId,secret,expiresAt:input.expiresAt };
}
export async function revokeMerchantApiCredential(input:{actorUserId:number;providerId:number;keyId:string}){
  await database().query("SELECT commerce.revoke_merchant_api_credential($1,$2,$3)",[input.actorUserId,input.providerId,input.keyId]);
  return {keyId:input.keyId,state:"revoked" as const};
}
export async function rotateMerchantApiCredential(input:{actorUserId:number;providerId:number;previousKeyId:string;scopes:("catalog:write"|"inventory:write"|"fulfillment:read"|"tracking:read")[];expiresAt:string}){
  const next=await issueMerchantApiCredential(input);
  try { await revokeMerchantApiCredential({actorUserId:input.actorUserId,providerId:input.providerId,keyId:input.previousKeyId}); } catch (error) { await revokeMerchantApiCredential({actorUserId:input.actorUserId,providerId:input.providerId,keyId:next.keyId}); throw error; }
  return next;
}
