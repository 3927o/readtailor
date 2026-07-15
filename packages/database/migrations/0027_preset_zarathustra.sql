-- Mark an already-ingested fixture as preset. ingest-fixture.ts also sets the flag when ingestion
-- happens after this migration; the hash fallback covers independently generated shared_book IDs.
UPDATE "shared_books"
SET "is_preset" = true
WHERE "id" = 'fd61c01c-2a18-484c-af8f-87cadbbb8989'
   OR "epub_sha256" = '5814044076bd72c553087c0166b65b635897b54499187f787036569abb81a6f6';
