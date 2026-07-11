export type InsertUser = {
  openId: string;
  email?: string | null;
  name?: string | null;
  role?: string | null;
  tenantId?: string | null;
  scopes?: string[] | null;
  [key: string]: unknown;
};

function createLooseTable(tableName: string) {
  return new Proxy(
    { _tableName: tableName } as Record<string, unknown>,
    {
      get(target, prop) {
        if (prop in target) return target[prop as keyof typeof target];
        return `${tableName}.${String(prop)}`;
      },
    },
  ) as any;
}

export const users = createLooseTable("users");
export const orders = createLooseTable("orders");
export const drivers = createLooseTable("drivers");
export const serviceProviders = createLooseTable("service_providers");
export const supportTickets = createLooseTable("support_tickets");
export const transactions = createLooseTable("transactions");
export const serviceVerticals = createLooseTable("service_verticals");
export const systemConfig = createLooseTable("system_config");
export const notifications = createLooseTable("notifications");
export const auditLogs = createLooseTable("audit_logs");
export const operationalEvents = createLooseTable("operational_events");
export const pushNotificationTokens = createLooseTable("push_notification_tokens");
export const driverPerformanceScores = createLooseTable("driver_performance_scores");
export const membershipPlans = createLooseTable("membership_plans");
export const consumerMemberships = createLooseTable("consumer_memberships");
export const consumerReviews = createLooseTable("consumer_reviews");
export const orderTrackingEvents = createLooseTable("order_tracking_events");
export const experimentRollouts = createLooseTable("experiment_rollouts");
export const platformIdempotencyKeys = createLooseTable("platform_idempotency_keys");
export const merchantReserves = createLooseTable("merchant_reserves");
export const treasuryReserves = createLooseTable("treasury_reserves");
export const providerCatalogItems = createLooseTable("provider_catalog_items");
export const providerOnboardingRequests = createLooseTable("provider_onboarding_requests");
export const verticalServiceTemplates = createLooseTable("vertical_service_templates");
export const customerServiceIntakeTemplates = createLooseTable("customer_service_intake_templates");
export const ledgerAccounts = createLooseTable("ledger_accounts");
export const ledgerEntries = createLooseTable("ledger_entries");
export const mojaloopTransfers = createLooseTable("mojaloop_transfers");
export const mojaloopQuotes = createLooseTable("mojaloop_quotes");
export const mojaloopRefunds = createLooseTable("mojaloop_refunds");
export const mojaloopIdempotencyKeys = createLooseTable("mojaloop_idempotency_keys");
export const mojaloopReconciliationAudits = createLooseTable("mojaloop_reconciliation_audits");
export const mojaloopWorkflows = createLooseTable("mojaloop_workflows");
export const mojaloopWorkflowEvents = createLooseTable("mojaloop_workflow_events");
export const mojaloopWorkflowOrchestration = createLooseTable("mojaloop_workflow_orchestration");
