CREATE TABLE "retry_queue" (
	"issue_id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"attempt" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_transitions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"status" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"message" text
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"issue_identifier" text NOT NULL,
	"workspace_key" text NOT NULL,
	"attempt" integer,
	"agent" text NOT NULL,
	"worker_name" text,
	"image_digest" text,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"exit_reason" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" integer,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_transitions" ADD CONSTRAINT "run_transitions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_transitions_run_idx" ON "run_transitions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runs_issue_idx" ON "runs" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "runs_started_idx" ON "runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");