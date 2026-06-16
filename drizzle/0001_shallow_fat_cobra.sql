CREATE TABLE "ml_demand_forecasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"vertical_id" integer NOT NULL,
	"location_lat" varchar(20) NOT NULL,
	"location_lng" varchar(20) NOT NULL,
	"forecast_timestamp" timestamp NOT NULL,
	"predicted_demand" varchar(20) NOT NULL,
	"confidence_lower" varchar(20) NOT NULL,
	"confidence_upper" varchar(20) NOT NULL,
	"model_version" varchar(50) NOT NULL,
	"actual_demand" varchar(20),
	"prediction_error" varchar(20),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ml_drift_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_type" varchar(50) NOT NULL,
	"model_name" varchar(100) NOT NULL,
	"model_version" varchar(50) NOT NULL,
	"drift_metric" varchar(50) NOT NULL,
	"drift_score" varchar(20) NOT NULL,
	"drift_threshold" varchar(20) NOT NULL,
	"is_drifted" boolean NOT NULL,
	"feature_name" varchar(100),
	"detection_timestamp" timestamp NOT NULL,
	"retraining_triggered" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ml_model_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_type" varchar(50) NOT NULL,
	"model_name" varchar(100) NOT NULL,
	"model_version" varchar(50) NOT NULL,
	"metric_name" varchar(100) NOT NULL,
	"metric_value" varchar(30) NOT NULL,
	"evaluation_date" timestamp NOT NULL,
	"dataset_size" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ml_pricing_predictions" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer,
	"vertical_id" integer NOT NULL,
	"base_price" varchar(20) NOT NULL,
	"optimized_price" varchar(20) NOT NULL,
	"surge_multiplier" varchar(10) NOT NULL,
	"demand_factor" varchar(10) NOT NULL,
	"supply_factor" varchar(10) NOT NULL,
	"time_factor" varchar(10) NOT NULL,
	"confidence_score" varchar(10) NOT NULL,
	"distance_km" varchar(20) NOT NULL,
	"current_demand" integer NOT NULL,
	"available_drivers" integer NOT NULL,
	"time_of_day" integer NOT NULL,
	"day_of_week" integer NOT NULL,
	"weather_condition" varchar(50),
	"model_version" varchar(50) NOT NULL,
	"actual_price" varchar(20),
	"was_accepted" boolean,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ml_retraining_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_type" varchar(50) NOT NULL,
	"model_name" varchar(100) NOT NULL,
	"old_version" varchar(50) NOT NULL,
	"new_version" varchar(50) NOT NULL,
	"trigger_reason" varchar(200) NOT NULL,
	"training_started_at" timestamp NOT NULL,
	"training_completed_at" timestamp,
	"training_duration_seconds" integer,
	"training_samples" integer,
	"validation_samples" integer,
	"training_metrics" text,
	"validation_metrics" text,
	"deployment_status" varchar(50) NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ml_demand_forecasts" ADD CONSTRAINT "ml_demand_forecasts_vertical_id_service_verticals_id_fk" FOREIGN KEY ("vertical_id") REFERENCES "public"."service_verticals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_pricing_predictions" ADD CONSTRAINT "ml_pricing_predictions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_pricing_predictions" ADD CONSTRAINT "ml_pricing_predictions_vertical_id_service_verticals_id_fk" FOREIGN KEY ("vertical_id") REFERENCES "public"."service_verticals"("id") ON DELETE no action ON UPDATE no action;