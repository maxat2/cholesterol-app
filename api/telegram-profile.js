export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const { telegram_id, profile } = await req.json();

  if (!telegram_id || !profile) {
    return new Response(JSON.stringify({ error: 'Missing telegram_id or profile' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Серверный ключ обходит RLS
  const headers = {
    'Content-Type': 'application/json',
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Prefer': 'return=minimal',
  };

  // Загружаем существующую строку
  const getRes = await fetch(
    `${supabaseUrl}/rest/v1/users?telegram_id=eq.${telegram_id}&select=*`,
    { headers }
  );
  const rows = await getRes.json();
  const existing = (rows && rows.length > 0) ? rows[0] : {};

  // Собираем patch из профиля
  const isMg = profile.units === 'mgdl';

  function toMmol(val, isTrig) {
    if (val == null) return null;
    return isTrig ? val / 88.57 : val / 38.67;
  }

  function parseF(v) {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  function parseI(v) {
    const n = parseInt(v);
    return isNaN(n) ? null : n;
  }

  const rawTotal = parseF(profile.v_total);
  const rawLdl   = parseF(profile.v_ldl);
  const rawHdl   = parseF(profile.v_hdl);
  const rawTrig  = parseF(profile.v_trig);
  const rawApob  = parseF(profile.v_apob);

  const totalMmol = rawTotal != null ? (isMg ? toMmol(rawTotal, false) : rawTotal) : existing.cholesterol ?? null;
  const ldlMmol   = rawLdl   != null ? (isMg ? toMmol(rawLdl,   false) : rawLdl)   : existing.ldl ?? null;
  const hdlMmol   = rawHdl   != null ? (isMg ? toMmol(rawHdl,   false) : rawHdl)   : existing.hdl ?? null;
  const trigMmol  = rawTrig  != null ? (isMg ? toMmol(rawTrig,  true)  : rawTrig)  : existing.triglycerides ?? null;

  const nameNew = String(profile.name ?? '').trim();
  const sex = (profile.gender === 'Мужской' || profile.gender === 'male') ? 'male'
            : (profile.gender === 'Женский' || profile.gender === 'female') ? 'female'
            : existing.sex ?? null;

  const patch = {
    name: nameNew || existing.name || null,
    age: parseI(profile.age) ?? existing.age ?? null,
    sex,
    height_cm: parseI(profile.height) ?? existing.height_cm ?? null,
    weight_kg: parseF(profile.weight) ?? existing.weight_kg ?? null,
    statins: profile.statins === true,
    units: profile.units === 'mgdl' ? 'mgdl' : 'mmol',
    body_type: profile.body_type || existing.body_type || null,
    activity_level: profile.activity || existing.activity_level || null,
    cholesterol: totalMmol,
    ldl: ldlMmol,
    hdl: hdlMmol,
    triglycerides: trigMmol,
    cholesterol_mmol: totalMmol,
    cholesterol_mgdl: totalMmol != null ? totalMmol * 38.67 : existing.cholesterol_mgdl ?? null,
    ldl_mmol: ldlMmol,
    ldl_mgdl: ldlMmol != null ? ldlMmol * 38.67 : existing.ldl_mgdl ?? null,
    hdl_mmol: hdlMmol,
    hdl_mgdl: hdlMmol != null ? hdlMmol * 38.67 : existing.hdl_mgdl ?? null,
    trig_mmol: trigMmol,
    trig_mgdl: trigMmol != null ? trigMmol * 88.57 : existing.trig_mgdl ?? null,
    apob: rawApob ?? existing.apob ?? null,
    profile_json: profile,
    updated_at: new Date().toISOString(),
  };

  const patchRes = await fetch(
    `${supabaseUrl}/rest/v1/users?telegram_id=eq.${telegram_id}`,
    { method: 'PATCH', headers, body: JSON.stringify(patch) }
  );

  return new Response(JSON.stringify({ ok: true, status: patchRes.status }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}
