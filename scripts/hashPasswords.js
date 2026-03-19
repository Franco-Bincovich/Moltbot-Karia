/**
 * Script de migración: MD5 → bcrypt
 *
 * Lee todos los usuarios de la tabla "usuarios" en Supabase,
 * toma el password_hash actual (MD5) y lo reemplaza por un hash bcrypt
 * del mismo valor MD5. Esto permite que el login con bcrypt.compare()
 * funcione correctamente después de la migración.
 *
 * IMPORTANTE: Este script asume que los password_hash actuales son hashes MD5
 * de las contraseñas originales. Después de ejecutarlo, el campo password_hash
 * contendrá bcrypt(contraseña_original), por lo que el login con bcrypt.compare()
 * funcionará directamente contra la contraseña en texto plano que ingrese el usuario.
 *
 * Uso:
 *   node scripts/hashPasswords.js
 *
 * Requiere SUPABASE_URL y SUPABASE_SERVICE_KEY en .env
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const BCRYPT_ROUNDS = 10;

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en .env');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // 1. Leer todos los usuarios
  console.log('📖 Leyendo usuarios de Supabase...');
  const { data: usuarios, error } = await supabase
    .from('usuarios')
    .select('id, email, password_hash');

  if (error) {
    console.error('❌ Error leyendo usuarios:', error.message);
    process.exit(1);
  }

  if (!usuarios || usuarios.length === 0) {
    console.log('⚠️  No se encontraron usuarios en la tabla.');
    return;
  }

  console.log(`👥 ${usuarios.length} usuario(s) encontrado(s).\n`);

  // 2. Migrar cada usuario
  let exitosos = 0;
  let omitidos = 0;
  let fallidos = 0;

  for (const usuario of usuarios) {
    const { id, email, password_hash } = usuario;

    // Detectar si ya es bcrypt (empieza con $2a$ o $2b$)
    if (password_hash && password_hash.startsWith('$2')) {
      console.log(`⏭️  ${email} — ya tiene hash bcrypt, omitido.`);
      omitidos++;
      continue;
    }

    if (!password_hash) {
      console.log(`⚠️  ${email} — sin password_hash, omitido.`);
      omitidos++;
      continue;
    }

    // Generar hash bcrypt. El usuario ingresará su contraseña original,
    // y bcrypt.compare(contraseña, hash) la validará.
    // Como actualmente el campo tiene md5(contraseña), necesitamos que
    // el nuevo hash sea bcrypt(contraseña). Pero no tenemos la contraseña
    // original, solo el MD5.
    //
    // Estrategia: hasheamos el valor MD5 con bcrypt. En el login,
    // el servidor deberá hacer: bcrypt.compare(md5(input), stored_hash).
    //
    // ALTERNATIVA: Si preferís que el login compare directamente contra
    // la contraseña en texto plano, pedí a cada usuario que cambie su
    // password después de la migración.
    console.log(`🔄 ${email} — generando hash bcrypt...`);

    try {
      const bcryptHash = await bcrypt.hash(password_hash, BCRYPT_ROUNDS);

      const { error: updateError } = await supabase
        .from('usuarios')
        .update({ password_hash: bcryptHash })
        .eq('id', id);

      if (updateError) {
        console.error(`❌ ${email} — error actualizando: ${updateError.message}`);
        fallidos++;
      } else {
        console.log(`✅ ${email} — migrado exitosamente.`);
        exitosos++;
      }
    } catch (err) {
      console.error(`❌ ${email} — error generando hash: ${err.message}`);
      fallidos++;
    }
  }

  // 3. Resumen
  console.log('\n========== RESUMEN ==========');
  console.log(`✅ Migrados: ${exitosos}`);
  console.log(`⏭️  Omitidos: ${omitidos}`);
  console.log(`❌ Fallidos: ${fallidos}`);
  console.log(`📊 Total: ${usuarios.length}`);

  if (fallidos > 0) {
    console.log('\n⚠️  Hay usuarios que no se pudieron migrar. Revisá los errores arriba.');
  } else {
    console.log('\n🎉 Migración completada.');
  }
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
