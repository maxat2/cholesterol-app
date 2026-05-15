export const config = { runtime: 'edge' };

async function verifyTelegramData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const secretKey = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(botToken));

  const verifyKey = await crypto.subtle.importKey(
    'raw', secretKey,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', verifyKey, encoder.encode(dataCheckString));

  const expectedHash = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  return expectedHash === hash;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const { initData } = await req.json();
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  const isValid = await verifyTelegramData(initData, botToken);
  if (!isValid) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const params = new URLSearchParams(initData);
  const user = JSON.parse(params.get('user'));
  const telegramId = user.id;
  const firstName = user.first_name || '';
  const username = user.username || '';

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
  };

  // Ищем по telegram_id
  const findRes = await fetch(
    `${supabaseUrl}/rest/v1/users?telegram_id=eq.${telegramId}&select=*`,
    { headers }
  );
  const found = await findRes.json();

  let userData;

  if (found && found.length > 0) {
    userData = found[0];
  } else {
    // Создаём нового пользователя
    const newUser = {
      telegram_id: telegramId,
      name: firstName,
      username: username,
      trial_start: new Date().toISOString(),
      active_plan: 'trial',
    };
    const createRes = await fetch(`${supabaseUrl}/rest/v1/users`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify(newUser),
    });
    const created = await createRes.json();
    // Если created массив — берём первый элемент, иначе сам объект
    userData = Array.isArray(created) ? created[0] : created;
  }

  if (!userData) {
    return new Response(JSON.stringify({ error: 'Failed to create user', debug: { telegramId, firstName } }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, user: userData }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}
