import { invokeLLM } from "./_core/llm";

export type SmartSearchRecord = {
  id: string;
  title: string;
  subtitle: string;
  severity: "stable" | "watch" | "critical";
  region?: string;
  note?: string;
  actionHint?: string;
};

export type SmartSearchInput = {
  query: string;
  region?: string;
  inventory: SmartSearchRecord[];
  dispatch: SmartSearchRecord[];
  limit?: number;
};

export type SmartSearchResult = {
  domain: "inventory" | "dispatch";
  recordId: string;
  title: string;
  subtitle: string;
  severity: "stable" | "watch" | "critical";
  reason: string;
  score: number;
  explanationChips: string[];
};

const SMART_SEARCH_MODEL = "gpt-5-mini";

function buildCatalog(records: SmartSearchRecord[]) {
  return records.map((record) => ({
    id: record.id,
    title: record.title,
    subtitle: record.subtitle,
    severity: record.severity,
    region: record.region ?? "",
    note: record.note ?? "",
    actionHint: record.actionHint ?? "",
  }));
}

export async function runSmartSearch(input: SmartSearchInput): Promise<SmartSearchResult[]> {
  const query = input.query.trim();
  if (!query) {
    return [];
  }

  const inventory = buildCatalog(input.inventory);
  const dispatch = buildCatalog(input.dispatch);
  const limit = Math.max(1, Math.min(input.limit ?? 6, 10));

  if (inventory.length === 0 && dispatch.length === 0) {
    return [];
  }

  const response = await invokeLLM({
    model: SMART_SEARCH_MODEL,
    reasoning: { effort: "low" },
    maxTokens: 2400,
    messages: [
      {
        role: "system",
        content:
          "You are an operations copilot for a delivery platform. Rank the most relevant inventory and dispatch records for a field operator's natural-language query. Use only the supplied records. Prefer critical and watch records when relevance is otherwise similar. Return concise, factual reasons and short explanation chips.",
      },
      {
        role: "user",
        content: JSON.stringify({
          operatorQuery: query,
          preferredRegion: input.region ?? null,
          limit,
          inventory,
          dispatch,
        }),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "smart_search_results",
        strict: true,
        schema: {
          type: "object",
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  domain: { type: "string", enum: ["inventory", "dispatch"] },
                  recordId: { type: "string" },
                  title: { type: "string" },
                  subtitle: { type: "string" },
                  severity: { type: "string", enum: ["stable", "watch", "critical"] },
                  reason: { type: "string" },
                  score: { type: "number" },
                  explanationChips: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: ["domain", "recordId", "title", "subtitle", "severity", "reason", "score", "explanationChips"],
                additionalProperties: false,
              },
            },
          },
          required: ["results"],
          additionalProperties: false,
        },
      },
    },
  });

  const raw = response.choices[0]?.message?.content;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : { results: [] };

  return Array.isArray(parsed.results)
    ? parsed.results
        .slice(0, limit)
        .map((item: SmartSearchResult) => ({
          ...item,
          score: Number.isFinite(item.score) ? Math.max(0, Math.min(100, Math.round(item.score))) : 0,
          explanationChips: Array.isArray(item.explanationChips) ? item.explanationChips.slice(0, 3) : [],
        }))
    : [];
}
