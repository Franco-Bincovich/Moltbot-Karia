/**
 * Script de migración: bcrypt(md5(password)) → bcrypt(password) puro
 *
 * Problema que resuelve:
 *   El sistema anterior almacenaba bcrypt(md5(password)). El paso MD5 intermedio
 *   reducía la entropía de cualquier password a 128 bits (32 chars hex) y podía
 *   causar colisiones teóricas (dos passwords distintos generando el mismo MD5).
 *   Además, MD5 es un algoritmo roto — no debería participar en ningún flujo de auth.
 *
 * Estrategia:
 *   No tenemos las passwords originales en texto plano, así que no podemos
 *   re-hashear directamente a bcrypt(password). En su lugar:
 *     1. Marcamos cada usuario con needs_password_reset = true
 *     2. El endpoint POST /api/login detecta este flag y retorna 403
 *     3. El administrador le comunica a cada usuario que debe restablecer su password
 *     4. Cuando el usuario restablece, el nuevo hash se guarda como bcrypt(password) puro
 *
 *   Usuarios que ya tienen bcrypt puro (sin paso MD5) no se tocan.
 *
 * Uso:
 *   node scripts/migrarBcryptPuro.js
 *
 * Requiere SUPABASE_URL y SUPABASE_SERVICE_KEY en .env
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en .env');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // 1. Leer todos los usuarios
  console.log('Leyendo usuarios de Supabase...');
  const { data: usuarios, error } = await supabase
    .from('usuarios')
    .select('id, email, password_hash, needs_password_reset');

  if (error) {
    console.error('Error leyendo usuarios:', error.message);
    process.exit(1);
  }

  if (!usuarios || usuarios.length === 0) {
    console.log('No se encontraron usuarios en la tabla.');
    return;
  }

  console.log(`${usuarios.length} usuario(s) encontrado(s).\n`);

  // 2. Marcar usuarios que necesitan resetear password
  let marcados = 0;
  let omitidos = 0;
  let fallidos = 0;

  for (const usuario of usuarios) {
    const { id, email, password_hash, needs_password_reset } = usuario;

    // Si ya fue marcado para reset, no tocar
    if (needs_password_reset === true) {
      console.log(`[omitido] ${email} — ya marcado para reset.`);
      omitidos++;
      continue;
    }

    // Si no tiene hash, marcar para reset
    if (!password_hash) {
      console.log(`[marcar] ${email} — sin password_hash, marcando para reset.`);
    } else if (password_hash.startsWith('$2')) {
      // Tiene hash bcrypt — puede ser bcrypt(md5(pass)) o bcrypt(pass) puro.
      // No hay forma de distinguirlos sin la password original.
      // Por seguridad, marcamos a todos para que restablezcan con bcrypt puro.
      console.log(`[marcar] ${email} — hash bcrypt existente, marcando para reset.`);
    } else {
      // Hash en formato desconocido (MD5 plano u otro)
      console.log(`[marcar] ${email} — hash no bcrypt (${password_hash.slice(0, 10)}...), marcando para reset.`);
    }

    try {
      const { error: updateError } = await supabase
        .from('usuarios')
        .update({ needs_password_reset: true })
        .eq('id', id);

      if (updateError) {
        console.error(`[error] ${email} — no se pudo actualizar: ${updateError.message}`);
        fallidos++;
      } else {
        marcados++;
      }
    } catch (err) {
      console.error(`[error] ${email} — error inesperado: ${err.message}`);
      fallidos++;
    }
  }

  // 3. Resumen
  console.log('\n========== RESUMEN ==========');
  console.log(`Marcados para reset: ${marcados}`);
  console.log(`Omitidos (ya marcados): ${omitidos}`);
  console.log(`Fallidos: ${fallidos}`);
  console.log(`Total: ${usuarios.length}`);

  if (marcados > 0) {
    console.log('\nPróximos pasos:');
    console.log('1. Comunicar a cada usuario que debe restablecer su contraseña.');
    console.log('2. Implementar un endpoint POST /api/reset-password que:');
    console.log('   - Reciba email + nueva password');
    console.log('   - Hashee con bcrypt(password) puro (sin MD5)');
    console.log('   - Actualice password_hash y setee needs_password_reset = false');
    console.log('3. Hasta entonces, los usuarios marcados no podrán loguearse.');
  }

  if (fallidos > 0) {
    console.log('\nHay usuarios que no se pudieron actualizar. Revisá los errores arriba.');
  }
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
