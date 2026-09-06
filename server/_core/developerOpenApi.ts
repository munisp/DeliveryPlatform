export const developerOpenApi = {
  openapi: "3.1.0",
  info: {
    title: "DeliveryPlatform Developer API",
    version: "v1",
    description:
      "Provider-scoped field-service work-order integration API. Keys are issued once through the operator developer console. All write requests require an idempotency key.",
  },
  servers: [
    {
      url: "https://{host}",
      variables: { host: { default: "api.example.invalid" } },
    },
  ],
  security: [{ ApiKey: [] }],
  components: {
    securitySchemes: {
      ApiKey: {
        type: "apiKey",
        in: "header",
        name: "X-API-Key",
        description:
          "Provider-scoped API key. The raw value is shown only at issue time.",
      },
    },
    parameters: {
      IdempotencyKey: {
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$",
        },
      },
    },
    schemas: {
      WorkOrderCreate: {
        type: "object",
        required: [
          "customerId",
          "serviceAreaId",
          "title",
          "description",
          "serviceAddress",
        ],
        additionalProperties: false,
        properties: {
          customerId: { type: "integer", minimum: 1 },
          serviceAreaId: { type: "string", format: "uuid" },
          title: { type: "string", minLength: 3, maxLength: 180 },
          description: { type: "string", minLength: 3, maxLength: 5000 },
          serviceAddress: { type: "string", minLength: 3, maxLength: 500 },
          latitude: { type: ["number", "null"], minimum: -90, maximum: 90 },
          longitude: { type: ["number", "null"], minimum: -180, maximum: 180 },
          priority: {
            type: "string",
            enum: ["low", "normal", "high", "urgent"],
            default: "normal",
          },
          scheduledStartAt: { type: ["string", "null"], format: "date-time" },
          scheduledEndAt: { type: ["string", "null"], format: "date-time" },
          sourceOrderId: { type: ["integer", "null"], minimum: 1 },
        },
      },
      WorkOrderAccepted: {
        type: "object",
        required: ["id", "status"],
        properties: {
          id: { type: "string", format: "uuid" },
          status: { const: "requested" },
        },
      },
      WorkOrderSummary: {
        type: "object",
        required: ["id", "reference", "state", "priority", "updated_at"],
        properties: {
          id: { type: "string", format: "uuid" },
          reference: { type: "string" },
          state: {
            type: "string",
            enum: [
              "requested",
              "scheduled",
              "assigned",
              "en_route",
              "on_site",
              "completed",
              "cancelled",
            ],
          },
          priority: {
            type: "string",
            enum: ["low", "normal", "high", "urgent"],
          },
          scheduled_start_at: { type: ["string", "null"], format: "date-time" },
          scheduled_end_at: { type: ["string", "null"], format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      Error: {
        type: "object",
        required: ["error"],
        properties: { error: { type: "string" } },
      },
    },
  },
  paths: {
    "/api/v1/field-service/work-orders": {
      post: {
        operationId: "createFieldServiceWorkOrder",
        summary: "Create a provider-scoped field-service work order",
        parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WorkOrderCreate" },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WorkOrderAccepted" },
              },
            },
          },
          "400": {
            description: "Invalid request",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          "401": { description: "Invalid API key" },
          "403": { description: "Scope or provider denied" },
          "409": { description: "Idempotency conflict or request in progress" },
        },
      },
    },
    "/api/v1/field-service/work-orders/{id}": {
      get: {
        operationId: "getFieldServiceWorkOrder",
        summary:
          "Read a privacy-minimized work-order status for the API client provider",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Work-order status",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WorkOrderSummary" },
              },
            },
          },
          "401": { description: "Invalid API key" },
          "403": { description: "Scope denied" },
          "404": { description: "Work order outside provider scope" },
        },
      },
    },
  },
} as const;
