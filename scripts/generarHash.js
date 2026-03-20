/**
 * Genera un hash bcrypt para una password y verifica que matchee.
 *
 * Uso:
 *   node scripts/generarHash.js
 */

const bcrypt = require('bcryptjs');

async function main() {
  const password = 'paltron89';
  const rounds = 12;

  console.log(`Password: ${password}`);
  console.log(`Rounds: ${rounds}`);
  console.log('Generando hash...\n');

  const hash = await bcrypt.hash(password, rounds);
  console.log(`Hash: ${hash}`);

  const match = await bcrypt.compare(password, hash);
  console.log(`Verificación: ${match ? 'OK — matchea correctamente' : 'FALLO — no matchea'}`);
}

main();
