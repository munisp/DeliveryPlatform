import { getPool } from "../db";

// Machine-readable requirement descriptors stored in
// public.vertical_compliance_packs (drizzle/0076_vertical_compliance_packs.sql).
// required_documents / handling_requirements are jsonb descriptor arrays,
// never prose-only, so onboarding and delivery flows can enforce them.

export type ComplianceDocumentRequirement = {
  code: string;
  label: string;
  issuer: string;
  verification: string;
  renewal: string;
  retention_days: number;
};

export type ComplianceHandlingRequirement = {
  code: string;
  label: string;
  enforcement: string;
  parameters: Record<string, unknown>;
};

export type ComplianceAgeRestriction = {
  minimum_age: number;
  verification: string;
  scope: string;
  jurisdictional_basis: string;
};

export type VerticalCompliancePack = {
  id: number;
  vertical_id: number | null;
  vertical_slug: string;
  vertical_name: string | null;
  jurisdiction: string;
  required_documents: ComplianceDocumentRequirement[];
  age_restriction: ComplianceAgeRestriction | null;
  handling_requirements: ComplianceHandlingRequirement[];
  active: boolean;
  updated_at: string;
};

export type VerticalComplianceSummary = {
  summary: {
    total_packs: number;
    active_packs: number;
    covered_verticals: number;
    age_restricted_packs: number;
    required_document_rules: number;
    handling_rules: number;
  };
  packs: VerticalCompliancePack[];
  uncovered_verticals: { id: number; name: string; slug: string }[];
};

type PackRow = {
  id: number;
  vertical_id: number | null;
  vertical_slug: string;
  vertical_name: string | null;
  jurisdiction: string;
  required_documents: unknown;
  age_restriction: unknown;
  handling_requirements: unknown;
  active: boolean;
  updated_at: string | Date;
};

function asDescriptorArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mapPackRow(row: PackRow): VerticalCompliancePack {
  const ageRestriction =
    row.age_restriction && typeof row.age_restriction === "object"
      ? (row.age_restriction as ComplianceAgeRestriction)
      : null;
  return {
    id: Number(row.id),
    vertical_id: row.vertical_id != null ? Number(row.vertical_id) : null,
    vertical_slug: String(row.vertical_slug),
    vertical_name: row.vertical_name != null ? String(row.vertical_name) : null,
    jurisdiction: String(row.jurisdiction),
    required_documents: asDescriptorArray<ComplianceDocumentRequirement>(
      row.required_documents,
    ),
    age_restriction: ageRestriction,
    handling_requirements: asDescriptorArray<ComplianceHandlingRequirement>(
      row.handling_requirements,
    ),
    active: Boolean(row.active),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

const PACK_SELECT = `
  SELECT
    p.id,
    p.vertical_id,
    p.vertical_slug,
    v.name AS vertical_name,
    p.jurisdiction,
    p.required_documents,
    p.age_restriction,
    p.handling_requirements,
    p.active,
    p.updated_at
  FROM public.vertical_compliance_packs p
  LEFT JOIN public.service_verticals v ON v.id = p.vertical_id
`;

export async function listCompliancePacks(
  vertical?: string,
): Promise<VerticalCompliancePack[]> {
  const pool = await getPool();
  const trimmed = vertical?.trim().toLowerCase();
  const result = trimmed
    ? await pool.query<PackRow>(
        `${PACK_SELECT}
         WHERE LOWER(p.vertical_slug) = $1
            OR LOWER(COALESCE(v.slug, '')) = $1
            OR LOWER(COALESCE(v.name, '')) = $1
         ORDER BY p.active DESC, p.vertical_slug ASC, p.jurisdiction ASC`,
        [trimmed],
      )
    : await pool.query<PackRow>(
        `${PACK_SELECT}
         ORDER BY p.active DESC, p.vertical_slug ASC, p.jurisdiction ASC`,
      );
  return result.rows.map(mapPackRow);
}

export async function getVerticalComplianceSummary(): Promise<VerticalComplianceSummary> {
  const pool = await getPool();
  const [packsResult, verticalsResult] = await Promise.all([
    pool.query<PackRow>(
      `${PACK_SELECT}
       ORDER BY p.active DESC, p.vertical_slug ASC, p.jurisdiction ASC`,
    ),
    pool.query<{ id: number; name: string; slug: string }>(
      `SELECT id, name, slug
       FROM public.service_verticals
       WHERE is_active = true
       ORDER BY name ASC`,
    ),
  ]);

  const packs = packsResult.rows.map(mapPackRow);
  const activePacks = packs.filter((pack) => pack.active);
  const coveredIds = new Set(
    activePacks
      .map((pack) => pack.vertical_id)
      .filter((id): id is number => id != null),
  );
  const coveredSlugs = new Set(
    activePacks.map((pack) => pack.vertical_slug.toLowerCase()),
  );

  const uncoveredVerticals = verticalsResult.rows.filter(
    (vertical) =>
      !coveredIds.has(Number(vertical.id)) &&
      !coveredSlugs.has(String(vertical.slug).toLowerCase()),
  );

  return {
    summary: {
      total_packs: packs.length,
      active_packs: activePacks.length,
      covered_verticals:
        verticalsResult.rows.length - uncoveredVerticals.length,
      age_restricted_packs: activePacks.filter(
        (pack) => pack.age_restriction != null,
      ).length,
      required_document_rules: activePacks.reduce(
        (total, pack) => total + pack.required_documents.length,
        0,
      ),
      handling_rules: activePacks.reduce(
        (total, pack) => total + pack.handling_requirements.length,
        0,
      ),
    },
    packs,
    uncovered_verticals: uncoveredVerticals.map((vertical) => ({
      id: Number(vertical.id),
      name: String(vertical.name),
      slug: String(vertical.slug),
    })),
  };
}
