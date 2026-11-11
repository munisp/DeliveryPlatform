-- Rollback for 0099_document_extraction.sql.
DROP TRIGGER IF EXISTS verification_document_extraction_append_only ON verification.document_extraction;
DROP FUNCTION IF EXISTS verification.get_case_extractions(integer,uuid);
DROP FUNCTION IF EXISTS verification.record_document_extraction(integer,uuid,uuid,text,boolean,jsonb,text,timestamptz);
DROP TABLE IF EXISTS verification.document_extraction;
