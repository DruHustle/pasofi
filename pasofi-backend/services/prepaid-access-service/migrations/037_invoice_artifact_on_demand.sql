-- Preserve historical PDFs and their hashes. New sales commit the immutable
-- invoice snapshot without depending on the PDF renderer.
ALTER TABLE paid_invoices
 ALTER COLUMN pdf_bytes DROP NOT NULL,
 ALTER COLUMN pdf_sha256 DROP NOT NULL,
 ADD CONSTRAINT paid_invoice_pdf_pair CHECK ((pdf_bytes IS NULL) = (pdf_sha256 IS NULL));
