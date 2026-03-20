-- ============================================================
-- Creación de buckets en Supabase Storage
-- ============================================================
--
-- Estos buckets almacenan los archivos generados por el agente.
-- Se usan en lugar de /tmp para que los archivos sean accesibles
-- desde múltiples instancias del servidor y no llenen el disco.
--
-- Ejecutar desde el SQL Editor de Supabase:
--   https://supabase.com/dashboard/project/{id}/sql
-- ============================================================

-- Bucket para documentos Word (.docx) y Excel (.xlsx) generados por export.js
INSERT INTO storage.buckets (id, name, public)
VALUES ('documentos', 'documentos', false)
ON CONFLICT (id) DO NOTHING;

-- Bucket para PDFs de presentaciones descargados de Gamma
INSERT INTO storage.buckets (id, name, public)
VALUES ('presentaciones', 'presentaciones', false)
ON CONFLICT (id) DO NOTHING;

-- Los buckets son privados (public: false). Los archivos solo se acceden
-- vía URLs firmadas generadas por el servidor con la service_key.
-- Esto evita que alguien acceda a los archivos sin autenticación.
