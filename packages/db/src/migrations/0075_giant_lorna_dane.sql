CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"source_agent_id" uuid NOT NULL,
	"sequence_label" text NOT NULL,
	"text" text NOT NULL,
	"metric_tool_id" text NOT NULL,
	"metric_args" jsonb NOT NULL,
	"metric_extract" text NOT NULL,
	"direction" text NOT NULL,
	"baseline_value" double precision NOT NULL,
	"baseline_date" text NOT NULL,
	"follow_up_days" integer DEFAULT 28 NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"adopted_at" timestamp with time zone,
	"actual_value" double precision,
	"actual_date" timestamp with time zone,
	"delta_absolute" double precision,
	"delta_percent" double precision,
	"outcome_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "suggestions_company_status_idx" ON "suggestions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "suggestions_issue_idx" ON "suggestions" USING btree ("source_issue_id");--> statement-breakpoint
CREATE INDEX "suggestions_followup_idx" ON "suggestions" USING btree ("status","adopted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suggestions_issue_label_uniq" ON "suggestions" USING btree ("source_issue_id","sequence_label");