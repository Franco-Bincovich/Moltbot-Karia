const { createClient } = require('@supabase/supabase-js');

/**
 * Crea y retorna un cliente de Supabase con service key (bypasea RLS).
 * Retorna null si las variables de entorno no están configuradas.
 */
function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

/**
 * Busca contactos por nombre en las listas del usuario.
 * @param {string} query - Nombre parcial o completo a buscar
 * @param {number} usuario_id - ID del usuario logueado
 * @returns {object} { found, unique?, contact?, contacts? }
 */
async function searchContacts(query, usuario_id) {
  const supabase = getSupabase();
  if (!supabase) return { found: false, error: 'Supabase no configurado.' };

  console.log(`[contacts] Buscando contacto: "${query}" para usuario ${usuario_id ?? 'todos'}`);

  let listaIds = null;

  if (usuario_id != null) {
    // Get lists belonging to this user
    const { data: listas, error: listError } = await supabase
      .from('listas_contactos')
      .select('id')
      .eq('usuario_id', usuario_id);

    if (listError) {
      console.error('[contacts] Error buscando listas:', listError.message);
      return { found: false, error: listError.message };
    }

    if (!listas || listas.length === 0) {
      return { found: false };
    }

    listaIds = listas.map((l) => l.id);
  }

  // Search contacts by name — filtered by lista_id if usuario_id was provided
  let query_builder = supabase
    .from('contactos')
    .select('nombre, email')
    .ilike('nombre', `%${query}%`);

  if (listaIds) {
    query_builder = query_builder.in('lista_id', listaIds);
  }

  const { data: contactos, error: contactError } = await query_builder;

  if (contactError) {
    console.error('[contacts] Error buscando contactos:', contactError.message);
    return { found: false, error: contactError.message };
  }

  if (!contactos || contactos.length === 0) {
    console.log(`[contacts] No se encontraron contactos para "${query}"`);
    return { found: false };
  }

  if (contactos.length === 1) {
    console.log(`[contacts] Contacto único encontrado: ${contactos[0].nombre} <${contactos[0].email}>`);
    return { found: true, unique: true, contact: contactos[0] };
  }

  console.log(`[contacts] ${contactos.length} contactos encontrados para "${query}"`);
  return { found: true, unique: false, contacts: contactos };
}

/**
 * Agrega un contacto nuevo a la primera lista del usuario.
 * @param {string} nombre - Nombre del contacto
 * @param {string} email - Email del contacto
 * @param {number} usuario_id - ID del usuario logueado
 * @returns {object} { success, error? }
 */
async function addContact(nombre, email, usuario_id) {
  const supabase = getSupabase();
  if (!supabase) return { success: false, error: 'Supabase no configurado.' };

  console.log(`[contacts] Agregando contacto: ${nombre} <${email}> para usuario ${usuario_id ?? 'todos'}`);

  // Get first list — filtered by usuario_id if provided, otherwise any list
  let listas_query = supabase.from('listas_contactos').select('id').limit(1);
  if (usuario_id != null) {
    listas_query = listas_query.eq('usuario_id', usuario_id);
  }

  const { data: listas, error: listError } = await listas_query;

  if (listError || !listas || listas.length === 0) {
    console.error('[contacts] No se encontró lista:', listError?.message);
    return { success: false, error: 'No se encontró una lista de contactos disponible.' };
  }

  const listaId = listas[0].id;

  const { error: insertError } = await supabase
    .from('contactos')
    .insert({ nombre, email, lista_id: listaId });

  if (insertError) {
    console.error('[contacts] Error insertando contacto:', insertError.message);
    return { success: false, error: insertError.message };
  }

  console.log(`[contacts] Contacto agregado: ${nombre} <${email}> en lista ${listaId}`);
  return { success: true };
}

module.exports = { searchContacts, addContact };
