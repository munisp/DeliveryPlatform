CREATE TABLE "ml_base_model_contributions" (
	"id" serial PRIMARY KEY NOT NULL,
	"ensemble_id" varchar(255) NOT NULL,
	"base_model_name" varchar(100) NOT NULL,
	"forecast_horizon" integer NOT NULL,
	"weight" numeric(5, 4) NOT NULL,
	"accuracy" numeric(5, 2),
	"mape" numeric(5, 2),
	"rmse" numeric(10, 2),
	"training_time_seconds" numeric(10, 2),
	"model_config" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ml_ensemble_models" (
	"id" serial PRIMARY KEY NOT NULL,
	"ensemble_id" varchar(255) NOT NULL,
	"ensemble_name" varchar(255) NOT NULL,
	"base_model_names" text NOT NULL,
	"meta_model_name" varchar(100) NOT NULL,
	"base_model_weights" text NOT NULL,
	"ensemble_accuracy" numeric(5, 2),
	"accuracy_improvement" numeric(5, 2),
	"training_time_seconds" numeric(10, 2),
	"cost_reduction_percent" numeric(5, 2),
	"n_segments" integer DEFAULT 5 NOT NULL,
	"k_folds" integer DEFAULT 3 NOT NULL,
	"training_data_size" integer,
	"forecast_horizon" integer,
	"vertical_id" integer,
	"status" varchar(50) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ml_ensemble_models_ensemble_id_unique" UNIQUE("ensemble_id")
);
--> statement-breakpoint
CREATE TABLE "ml_external_features" (
	"id" serial PRIMARY KEY NOT NULL,
	"feature_date" timestamp NOT NULL,
	"feature_type" varchar(50) NOT NULL,
	"feature_name" varchar(255) NOT NULL,
	"feature_value" text NOT NULL,
	"impact_score" numeric(5, 4),
	"vertical_id" integer,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"created_at" timestamp DEFAULT now() NOT NULL
);
