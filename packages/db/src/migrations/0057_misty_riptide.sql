ALTER TABLE "memory_local_records" ADD COLUMN "scope_type" text DEFAULT 'org' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "scope_id" text;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "scope_workspace_id" text;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "scope_team_id" text;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "owner_type" text;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "created_by_actor_type" text;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "created_by_actor_id" text;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "sensitivity_label" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "retention_policy" jsonb;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "retention_state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "citation_json" jsonb;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "supersedes_record_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "superseded_by_record_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "revoked_by_actor_type" text;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "revoked_by_actor_id" text;--> statement-breakpoint
ALTER TABLE "memory_local_records" ADD COLUMN "revocation_reason" text;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD COLUMN "scope_type" text;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD COLUMN "scope_id" text;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD COLUMN "scope_workspace_id" text;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD COLUMN "scope_team_id" text;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD COLUMN "max_sensitivity_label" text;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD COLUMN "policy_decision_json" jsonb;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD COLUMN "revocation_selector_json" jsonb;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD COLUMN "retention_action_json" jsonb;--> statement-breakpoint
UPDATE "memory_local_records"
SET
	"scope_type" = CASE
		WHEN "scope_run_id" IS NOT NULL THEN 'run'
		WHEN "scope_agent_id" IS NOT NULL THEN 'agent'
		WHEN "scope_project_id" IS NOT NULL THEN 'project'
		ELSE 'org'
	END,
	"scope_id" = COALESCE("scope_run_id"::text, "scope_agent_id"::text, "scope_project_id"::text, "company_id"::text),
	"retention_state" = CASE WHEN "deleted_at" IS NOT NULL THEN 'revoked' ELSE 'active' END,
	"revoked_at" = CASE WHEN "deleted_at" IS NOT NULL THEN "deleted_at" ELSE NULL END,
	"revocation_reason" = CASE WHEN "deleted_at" IS NOT NULL THEN 'Record was forgotten before governed memory migration' ELSE NULL END;--> statement-breakpoint
UPDATE "memory_local_records" AS "record"
SET
	"owner_type" = "operation"."actor_type",
	"owner_id" = "operation"."actor_id",
	"created_by_actor_type" = "operation"."actor_type",
	"created_by_actor_id" = "operation"."actor_id"
FROM "memory_operations" AS "operation"
WHERE "record"."created_by_operation_id" = "operation"."id";--> statement-breakpoint
UPDATE "memory_operations"
SET
	"scope_type" = CASE
		WHEN "scope_run_id" IS NOT NULL THEN 'run'
		WHEN "scope_agent_id" IS NOT NULL THEN 'agent'
		WHEN "scope_project_id" IS NOT NULL THEN 'project'
		ELSE 'org'
	END,
	"scope_id" = COALESCE("scope_run_id"::text, "scope_agent_id"::text, "scope_project_id"::text, "company_id"::text);--> statement-breakpoint
CREATE INDEX "memory_local_records_company_scope_created_idx" ON "memory_local_records" USING btree ("company_id","scope_type","scope_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_local_records_company_sensitivity_created_idx" ON "memory_local_records" USING btree ("company_id","sensitivity_label","created_at");--> statement-breakpoint
CREATE INDEX "memory_local_records_company_retention_created_idx" ON "memory_local_records" USING btree ("company_id","retention_state","expires_at","created_at");--> statement-breakpoint
CREATE INDEX "memory_operations_company_scope_occurred_idx" ON "memory_operations" USING btree ("company_id","scope_type","scope_id","occurred_at");
