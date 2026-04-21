ALTER TABLE "memory_extraction_jobs"
DROP CONSTRAINT IF EXISTS "memory_extraction_jobs_binding_id_memory_bindings_id_fk";--> statement-breakpoint
ALTER TABLE "memory_extraction_jobs"
DROP CONSTRAINT IF EXISTS "memory_extraction_jobs_operation_id_memory_operations_id_fk";--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
		  AND table_name = 'memory_extraction_jobs'
		  AND column_name = 'provider_key'
	) THEN
		EXECUTE 'ALTER TABLE "memory_extraction_jobs" ALTER COLUMN "provider_key" DROP NOT NULL';
	END IF;
END $$;--> statement-breakpoint
