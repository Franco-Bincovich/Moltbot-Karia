-- ============================================================
-- Row Level Security (RLS) para Moltbot KarIA
-- ============================================================
--
-- Cada usuario solo puede ver y modificar sus propios datos.
-- El service_key del servidor bypasea RLS automáticamente,
-- por lo que las operaciones del backend no se ven afectadas.
--
-- Ejecutar este script desde el SQL Editor de Supabase o con:
--   psql $DATABASE_URL -f scripts/setupRLS.sql
-- ============================================================


-- ============================================================
-- 1. SESIONES
-- ============================================================
-- Cada sesión pertenece a un usuario (campo usuario_id).
-- Un usuario solo puede ver, crear y eliminar sus propias sesiones.

ALTER TABLE sesiones ENABLE ROW LEVEL SECURITY;

-- Ver solo sus propias sesiones
CREATE POLICY "sesiones_select_own"
  ON sesiones FOR SELECT
  USING (usuario_id = auth.uid()::int);

-- Crear sesiones solo para sí mismo
CREATE POLICY "sesiones_insert_own"
  ON sesiones FOR INSERT
  WITH CHECK (usuario_id = auth.uid()::int);

-- Eliminar solo sus propias sesiones
CREATE POLICY "sesiones_delete_own"
  ON sesiones FOR DELETE
  USING (usuario_id = auth.uid()::int);


-- ============================================================
-- 2. CONVERSACIONES
-- ============================================================
-- Cada mensaje pertenece a una sesión, y cada sesión a un usuario.
-- Un usuario solo puede ver y crear mensajes en sus propias sesiones.

ALTER TABLE conversaciones ENABLE ROW LEVEL SECURITY;

-- Ver solo mensajes de sus propias sesiones
CREATE POLICY "conversaciones_select_own"
  ON conversaciones FOR SELECT
  USING (
    sesion_id IN (
      SELECT id FROM sesiones WHERE usuario_id = auth.uid()::int
    )
  );

-- Crear mensajes solo en sus propias sesiones
CREATE POLICY "conversaciones_insert_own"
  ON conversaciones FOR INSERT
  WITH CHECK (
    sesion_id IN (
      SELECT id FROM sesiones WHERE usuario_id = auth.uid()::int
    )
  );


-- ============================================================
-- 3. LISTAS_CONTACTOS
-- ============================================================
-- Cada lista pertenece a un usuario (campo usuario_id).
-- Un usuario solo puede ver, crear y eliminar sus propias listas.

ALTER TABLE listas_contactos ENABLE ROW LEVEL SECURITY;

-- Ver solo sus propias listas
CREATE POLICY "listas_contactos_select_own"
  ON listas_contactos FOR SELECT
  USING (usuario_id = auth.uid()::int);

-- Crear listas solo para sí mismo
CREATE POLICY "listas_contactos_insert_own"
  ON listas_contactos FOR INSERT
  WITH CHECK (usuario_id = auth.uid()::int);

-- Eliminar solo sus propias listas
CREATE POLICY "listas_contactos_delete_own"
  ON listas_contactos FOR DELETE
  USING (usuario_id = auth.uid()::int);


-- ============================================================
-- 4. CONTACTOS
-- ============================================================
-- Cada contacto pertenece a una lista (campo lista_id),
-- y cada lista pertenece a un usuario.
-- Un usuario solo puede operar sobre contactos de sus propias listas.

ALTER TABLE contactos ENABLE ROW LEVEL SECURITY;

-- Ver solo contactos de sus propias listas
CREATE POLICY "contactos_select_own"
  ON contactos FOR SELECT
  USING (
    lista_id IN (
      SELECT id FROM listas_contactos WHERE usuario_id = auth.uid()::int
    )
  );

-- Agregar contactos solo a sus propias listas
CREATE POLICY "contactos_insert_own"
  ON contactos FOR INSERT
  WITH CHECK (
    lista_id IN (
      SELECT id FROM listas_contactos WHERE usuario_id = auth.uid()::int
    )
  );

-- Eliminar contactos solo de sus propias listas
CREATE POLICY "contactos_delete_own"
  ON contactos FOR DELETE
  USING (
    lista_id IN (
      SELECT id FROM listas_contactos WHERE usuario_id = auth.uid()::int
    )
  );
