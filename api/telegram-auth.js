import crypto from 'crypto';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const { initData } = await req.json();

  // 1. Верификация подписи Telegram
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const expectedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (expectedHash !== hash) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. Достаём данные пользователя
  const user = JSON.parse(params.get('user'));
  const telegramId = user.id;
  const firstName = user.first_name || '';
  const username = user.username || '';

  // 3. Ищем или создаём пользователя в Supabase
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

  if (found.length > 0) {
    // Пользователь найден
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
    userData = created[0];
  }

  return new Response(JSON.stringify({ ok: true, user: userData }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
