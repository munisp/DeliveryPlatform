import {
  boolean,
  integer,
  json,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

// Real pgTable definitions for the platform core tables.
// Column names/types mirror drizzle/0000_jittery_pride.sql and the later
// ALTER TABLE migrations (0005, 0025, scripts/init-local-postgres.sql).
// The SQL migrations remain the authoritative DDL; this schema exists so
// drizzle-orm queries and drizzle-kit tooling operate on real tables.

export const userRole = pgEnum("user_role", ["user", "admin"]);
export const driverStatus = pgEnum("driver_status", ["online", "offline", "busy"]);
export const orderStatus = pgEnum("order_status", [
  "pending",
  "confirmed",
  "assigned",
  "picked_up",
  "in_transit",
  "delivered",
  "cancelled",
  "refunded",
]);
export const providerStatus = pgEnum("provider_status", ["pending", "active", "suspended", "rejected"]);
export const verificationStatus = pgEnum("verification_status", ["pending", "verified", "rejected"]);
export const notificationType = pgEnum("notification_type", ["order", "driver", "system", "alert", "emergency"]);
export const priority = pgEnum("priority", ["low", "medium", "high", "urgent", "critical"]);
export const ticketType = pgEnum("ticket_type", ["order_issue", "payment", "driver", "general", "claim", "refund"]);
export const ticketStatus = pgEnum("ticket_status", ["open", "in_progress", "resolved", "closed"]);
export const transactionType = pgEnum("transaction_type", ["payment", "refund", "payout", "settlement", "commission"]);
export const transactionStatus = pgEnum("transaction_status", ["pending", "completed", "failed", "cancelled"]);
export const recipientType = pgEnum("recipient_type", ["driver", "provider", "customer", "platform"]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  openId: varchar("open_id", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("login_method", { length: 64 }),
  role: userRole("role").default("user").notNull(),
  phone: varchar("phone", { length: 20 }),
  referralCode: varchar("referral_code", { length: 50 }),
  referredByCode: varchar("referred_by_code", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  lastSignedIn: timestamp("last_signed_in").defaultNow().notNull(),
});

export type InsertUser = typeof users.$inferInsert;
export type SelectUser = typeof users.$inferSelect;

export const drivers = pgTable("drivers", {
  id: serial("id").primaryKey(),
  openId: varchar("open_id", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 320 }),
  phone: varchar("phone", { length: 20 }).notNull(),
  profileImage: varchar("profile_image", { length: 500 }),
  status: driverStatus("status").default("offline").notNull(),
  vehicleType: varchar("vehicle_type", { length: 50 }),
  vehicleNumber: varchar("vehicle_number", { length: 50 }),
  licenseNumber: varchar("license_number", { length: 100 }),
  licenseVerified: boolean("license_verified").default(false).notNull(),
  currentLatitude: varchar("current_latitude", { length: 20 }),
  currentLongitude: varchar("current_longitude", { length: 20 }),
  lastLocationUpdate: timestamp("last_location_update"),
  rating: varchar("rating", { length: 10 }).default("0"),
  totalOrders: integer("total_orders").default(0).notNull(),
  acceptanceRate: numeric("acceptance_rate", { precision: 10, scale: 2 }).default("80"),
  completionRate: numeric("completion_rate", { precision: 10, scale: 2 }).default("95"),
  totalEarnings: numeric("total_earnings", { precision: 12, scale: 2 }).default("0"),
  availability: varchar("availability", { length: 32 }).default("available"),
  currentLocation: text("current_location"),
  primaryVerticalId: integer("primary_vertical_id"),
  activeOrders: integer("active_orders").default(0).notNull(),
  completedDeliveries: integer("completed_deliveries").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  orderNumber: varchar("order_number", { length: 50 }).notNull().unique(),
  customerId: integer("customer_id").notNull(),
  verticalId: integer("vertical_id").notNull(),
  providerId: integer("provider_id"),
  serviceProviderId: integer("service_provider_id"),
  driverId: integer("driver_id"),
  status: orderStatus("status").default("pending").notNull(),
  totalAmount: varchar("total_amount", { length: 20 }).notNull(),
  platformFee: varchar("platform_fee", { length: 20 }).default("0"),
  driverFee: varchar("driver_fee", { length: 20 }).default("0"),
  pickupAddress: text("pickup_address"),
  pickupLatitude: varchar("pickup_latitude", { length: 20 }),
  pickupLongitude: varchar("pickup_longitude", { length: 20 }),
  deliveryAddress: text("delivery_address"),
  deliveryLatitude: varchar("delivery_latitude", { length: 20 }),
  deliveryLongitude: varchar("delivery_longitude", { length: 20 }),
  scheduledPickupTime: timestamp("scheduled_pickup_time"),
  actualPickupTime: timestamp("actual_pickup_time"),
  actualDeliveryTime: timestamp("actual_delivery_time"),
  estimatedDeliveryTime: timestamp("estimated_delivery_time"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const serviceVerticals = pgTable("service_verticals", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  description: text("description"),
  icon: varchar("icon", { length: 255 }),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const serviceProviders = pgTable("service_providers", {
  id: serial("id").primaryKey(),
  verticalId: integer("vertical_id").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  businessName: varchar("business_name", { length: 255 }).notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  phone: varchar("phone", { length: 20 }).notNull(),
  address: text("address"),
  latitude: varchar("latitude", { length: 20 }),
  longitude: varchar("longitude", { length: 20 }),
  status: providerStatus("status").default("pending").notNull(),
  verificationStatus: verificationStatus("verification_status").default("pending").notNull(),
  rating: varchar("rating", { length: 10 }).default("0"),
  commissionRate: varchar("commission_rate", { length: 10 }).default("15"),
  category: varchar("category", { length: 100 }).default("general"),
  completedServices: integer("completed_services").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const supportTickets = pgTable("support_tickets", {
  id: serial("id").primaryKey(),
  ticketNumber: varchar("ticket_number", { length: 50 }).notNull().unique(),
  customerId: integer("customer_id"),
  orderId: integer("order_id"),
  type: ticketType("type").notNull(),
  priority: priority("priority").default("medium").notNull(),
  status: ticketStatus("status").default("open").notNull(),
  subject: varchar("subject", { length: 255 }).notNull(),
  description: text("description").notNull(),
  assignedTo: integer("assigned_to"),
  resolution: text("resolution"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
});

export const systemConfig = pgTable("system_config", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 100 }).notNull().unique(),
  value: text("value").notNull(),
  category: varchar("category", { length: 50 }).notNull(),
  description: text("description"),
  updatedBy: integer("updated_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  transactionId: varchar("transaction_id", { length: 100 }).notNull().unique(),
  orderId: integer("order_id"),
  type: transactionType("type").notNull(),
  amount: varchar("amount", { length: 20 }).notNull(),
  currency: varchar("currency", { length: 3 }).default("EUR").notNull(),
  status: transactionStatus("status").default("pending").notNull(),
  paymentMethod: varchar("payment_method", { length: 50 }),
  recipientType: recipientType("recipient_type"),
  recipientId: integer("recipient_id"),
  metadata: json("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  type: notificationType("type").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message").notNull(),
  priority: priority("priority").default("medium").notNull(),
  isRead: boolean("is_read").default(false).notNull(),
  metadata: json("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  action: varchar("action", { length: 100 }).notNull(),
  entity: varchar("entity", { length: 100 }).notNull(),
  entityId: integer("entity_id"),
  changes: json("changes"),
  ipAddress: varchar("ip_address", { length: 45 }),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Loyalty account (current balance/tier) and journal (point movements).
// DDL authority: scripts/init-local-postgres.sql.
export const loyaltyPoints = pgTable("loyalty_points", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  pointsBalance: integer("points_balance").default(0).notNull(),
  lifetimePoints: integer("lifetime_points").default(0).notNull(),
  tier: varchar("tier", { length: 32 }).default("bronze").notNull(),
  tierProgress: numeric("tier_progress", { precision: 10, scale: 2 }).default("0").notNull(),
  nextTierThreshold: integer("next_tier_threshold").default(1000).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const loyaltyTransactions = pgTable("loyalty_transactions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  transactionType: varchar("transaction_type", { length: 64 }).notNull(),
  points: integer("points").notNull(),
  orderId: integer("order_id"),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Driver payout settlements. No in-repo DDL; columns mirror the raw SQL in
// server/db.ts (generateMonthlySettlement / approveSettlement / processSettlement).
export const payoutSettlements = pgTable("payout_settlements", {
  id: serial("id").primaryKey(),
  driverId: integer("driver_id").notNull(),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  baseEarnings: numeric("base_earnings", { precision: 12, scale: 2 }).default("0").notNull(),
  bonusAmount: numeric("bonus_amount", { precision: 12, scale: 2 }).default("0").notNull(),
  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).default("0").notNull(),
  status: varchar("status", { length: 32 }).default("pending").notNull(),
  approvedBy: integer("approved_by"),
  approvedAt: timestamp("approved_at"),
  processedAt: timestamp("processed_at"),
  paymentMethod: varchar("payment_method", { length: 64 }),
  paymentReference: varchar("payment_reference", { length: 160 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
