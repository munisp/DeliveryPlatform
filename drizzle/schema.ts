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
