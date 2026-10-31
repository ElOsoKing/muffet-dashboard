const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_SECRET    = process.env.TWITCH_SECRET;
const EVENTSUB_SECRET  = process.env.EVENTSUB_SECRET || 'muffetbot-secret-2026';
const SESSION_SECRET   = process.env.SESSION_SECRET || 'muffet-secreto';
const BASE_URL         = process.env.BASE_URL || 'http://localhost:8080';
const PORT             = process.env.PORT || 8080;
const SPOTIFY_SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
const IS_PROD          = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

// ── Trust proxy para HTTPS en Render/Railway ──
app.set('trust proxy', 1);

// Raw body para verificar firma de Twitch EventSub
app.use('/webhook/twitch', express.raw({ type: 'application/json' }));

// ── LEMON SQUEEZY WEBHOOK — debe ir ANTES de express.json() ──
app.post('/webhooks/lemonsqueezy', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    const signature = req.headers['x-signature'];
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

    // Verificar firma
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const digest = hmac.digest('hex');

    if (digest !== signature) {
      console.log(`[LS Webhook] Firma inválida — esperada: ${digest}, recibida: ${signature}`);
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = JSON.parse(rawBody.toString());
    const eventName = payload.meta?.event_name;
    const data = payload.data?.attributes;
    const customData = payload.meta?.custom_data;
    const variantId = String(data?.variant_id || '');
    const customerId = String(data?.customer_id || '');
    const subscriptionId = String(payload.data?.id || '');
    const twitchId = customData?.twitch_id;

    console.log(`[LS Webhook] Event: ${eventName} | twitch_id: ${twitchId} | variant: ${variantId}`);

    const variantMap = {
      [process.env.LEMONSQUEEZY_VARIANT_MONTHLY]:   1,
      [process.env.LEMONSQUEEZY_VARIANT_QUARTERLY]:  3,
      [process.env.LEMONSQUEEZY_VARIANT_BIANNUAL]:   6,
      [process.env.LEMONSQUEEZY_VARIANT_ANNUAL]:     12,
    };
    const months = variantMap[variantId] || 1;

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + months);

    let streamer = null;
    if (twitchId) streamer = await sbSelect('streamers', { twitch_id: twitchId });

    if (!streamer) {
      console.log(`[LS Webhook] Streamer no encontrado — twitch_id: ${twitchId}`);
      return res.status(200).json({ received: true });
    }

    if (eventName === 'subscription_created' || eventName === 'subscription_updated') {
      const status = data?.status;
      if (status === 'active' || status === 'on_trial') {
        await sbUpdate('streamers', {
          plan: 'pro',
          plan_expires_at: expiresAt.toISOString(),
          lemon_customer_id: customerId,
          lemon_subscription_id: subscriptionId,
        }, { twitch_id: streamer.twitch_id });
        console.log(`[LS] ✅ Plan Pro activado para ${streamer.twitch_username} hasta ${expiresAt.toISOString()}`);
      }
    }

    if (eventName === 'subscription_cancelled') {
      // Al cancelar mantenemos el Pro hasta que venza el período pagado
      await sbUpdate('streamers', {
        lemon_subscription_id: null, // ya no hay suscripción activa para cobrar
      }, { twitch_id: streamer.twitch_id });
      console.log(`[LS] ⚠️ Suscripción cancelada para ${streamer.twitch_username} — mantiene Pro hasta ${streamer.plan_expires_at}`);
    }

    if (eventName === 'subscription_expired') {
      // Solo al expirar quitamos el Pro
      await sbUpdate('streamers', {
        plan: 'free',
        plan_expires_at: null,
        lemon_subscription_id: null,
      }, { twitch_id: streamer.twitch_id });
      console.log(`[LS] ❌ Plan expirado para ${streamer.twitch_username}`);
    }

    res.status(200).json({ received: true });
  } catch(err) {
    console.error('[LS Webhook Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

const globalJsonParser = express.json({ limit: '50kb' });
app.use((req, res, next) => {
  // El upload de media alerts usa su propio parser con límite de 8MB — el global lo saltea
  if (req.path === '/api/media-alerts/upload') return next();
  return globalJsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PROD,   // HTTPS en producción
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// ── Supabase helpers ──
const sbHeaders = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// cols: columnas a pedir (por defecto todas). Los endpoints que se consultan seguido piden solo las que usan;
// si Supabase rechaza alguna columna, se reintenta pidiendo todas para no dejar el endpoint sin respuesta.
async function sbSelect(table, filters = {}, cols = '*') {
  const query = Object.entries(filters).map(([k,v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
  const run = async (c) => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&select=${c}&limit=1`, { headers: sbHeaders });
    return res.json();
  };
  let data = await run(cols);
  if (!Array.isArray(data) && cols !== '*') data = await run('*');
  return Array.isArray(data) ? data[0] || null : null;
}

// Caché corta con "una sola consulta a la vez": muchos overlays abiertos preguntando lo mismo comparten una respuesta
const _ttlCache = new Map(); // key -> { ts, promise }
function ttlCache(key, ttlMs, fn) {
  const hit = _ttlCache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.promise;
  const promise = Promise.resolve().then(fn);
  _ttlCache.set(key, { ts: Date.now(), promise });
  promise.catch(() => { if (_ttlCache.get(key)?.promise === promise) _ttlCache.delete(key); }); // los errores no se guardan
  if (_ttlCache.size > 500) { const lim = Date.now() - 60000; for (const [k, v] of _ttlCache) if (v.ts < lim) _ttlCache.delete(k); }
  return promise;
}

async function sbInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'return=representation' },
    body: JSON.stringify(row)
  });
  const data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

async function sbUpdate(table, row, filters = {}) {
  const query = Object.entries(filters).map(([k,v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Prefer': 'return=representation' },
    body: JSON.stringify(row)
  });
  const data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  if (!req.session.user.approved) return res.redirect('/pending');
  next();
}

// ── Validadores ──
function isValidObject(val) {
  return val && typeof val === 'object' && !Array.isArray(val);
}
function isValidArray(val) {
  return Array.isArray(val);
}
function isValidString(val, maxLen = 2000) {
  return typeof val === 'string' && val.length <= maxLen;
}

// ══════════════════════════════════════════
//  RUTAS PÚBLICAS
// ══════════════════════════════════════════
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/auth/twitch', (req, res) => {
  const redirectUri = BASE_URL + '/auth/twitch/callback';
  const scopes = 'user:read:email channel:manage:broadcast clips:edit channel:read:redemptions channel:manage:redemptions moderator:read:followers channel:bot';
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}`;
  res.redirect(url);
});

// ── Autorizar la cuenta del bot (ej. MuffetBot_) con ESTA app de Twitch ──
// Es lo que permite que Muffet envíe por la API y muestre la insignia de bot.
// Solo el admin lo inicia; el login normal y la sesión no se tocan. No se guarda ningún token: la autorización queda registrada en Twitch.
function startBotAuth(kind, extraScopes) {
  return (req, res) => {
  const state = require('crypto').randomBytes(16).toString('hex');
  req.session.botAuthState = state;
  req.session.botAuthKind = kind;
  const redirectUri = BASE_URL + '/auth/twitch/callback';
  const scopes = extraScopes || 'user:read:chat user:write:chat user:bot';
  // force_verify: Twitch pregunta con qué cuenta entrar, así puedes elegir la cuenta del bot en vez de la tuya
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}&state=${state}${kind === 'channelbot' ? '' : '&force_verify=true'}`;
  req.session.save(() => res.redirect(url));
  };
}
app.get('/auth/twitch/bot', requireAdmin, startBotAuth('main'));
// Cada streamer con bot propio autoriza la cuenta de SU bot con la app de Muffet (para la insignia de bot)
app.get('/auth/twitch/custom-bot', requireAuth, startBotAuth('custom'));
// El streamer da permiso a Muffet (channel:bot) con SU cuenta: así el bot principal puede enviar con insignia sin ser moderador
app.get('/auth/twitch/channel-bot', requireAuth, startBotAuth('channelbot', 'channel:bot'));
app.get('/api/channel-bot-status', requireAuth, async (req, res) => {
  const g = await getSetting('channel_bot:' + String(req.session.user.username).toLowerCase());
  res.json({ authorized: !!g, at: g?.authorized_at || null });
});

async function handleChannelBotCallback(req, res, code) {
  const page = (ok, title, body) => res.status(ok ? 200 : 400).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;background:#0e0e12;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0"><div style="max-width:520px;padding:28px;background:#1a1a22;border-radius:14px;border:1px solid ${ok ? '#3ecf8e' : '#e05a7a'}"><h2 style="margin-top:0">${title}</h2>${body}<p><a style="color:#b794ff" href="/dashboard">← Volver al dashboard</a></p></div>`);
  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_SECRET, code, grant_type: 'authorization_code', redirect_uri: BASE_URL + '/auth/twitch/callback' }).toString()
    });
    const t = await tokenRes.json();
    if (!t.access_token) return page(false, 'No se pudo autorizar', '<p>Twitch no aceptó el código. Inténtalo de nuevo desde el dashboard.</p>');
    const v = await (await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${t.access_token}` } })).json();
    if (!(v.scopes || []).includes('channel:bot')) return page(false, 'Faltó el permiso', '<p>No se aceptó el permiso. Vuelve a intentarlo y pulsa Autorizar.</p>');
    if (String(v.user_id) !== String(req.session.user.id)) return page(false, 'Cuenta distinta', `<p>Autorizaste con <b>@${v.login}</b>, pero tu sesión del dashboard es <b>@${req.session.user.username}</b>. Entra a Twitch con tu cuenta de streamer e inténtalo otra vez.</p>`);
    await setSetting('channel_bot:' + String(v.login).toLowerCase(), { login: v.login, user_id: v.user_id, authorized_at: new Date().toISOString() });
    adminLog(req, 'permiso de bot a Muffet (channel:bot)', v.login, 'ok');
    return page(true, '✅ Muffet autorizada', `<p>Listo, <b>@${v.login}</b>. Muffet ya puede mostrar la insignia de bot en tu chat sin que tengas que darle moderador.</p><p style="color:#9a96ad;font-size:13px">Si quieres que modere (borrar mensajes, timeouts), sigue siendo necesario darle moderador: <code>/mod MuffetBot_</code>.</p>`);
  } catch (err) {
    console.error('channel-bot callback:', err.message);
    return page(false, 'Error', '<p>Algo falló al autorizar. Inténtalo de nuevo.</p>');
  }
}
// Enlace firmado (sin depender de la sesión): se puede abrir en una ventana de incógnito, donde Twitch pide
// iniciar sesión directamente con la cuenta del bot, sin cerrar la sesión del streamer. Caduca en 30 min.
function signBotState(ownerId, kind = 'custom') {
  const payload = Buffer.from(JSON.stringify({ k: kind, o: String(ownerId), e: Date.now() + 30 * 60 * 1000, n: require('crypto').randomBytes(6).toString('hex') })).toString('base64url');
  const sig = require('crypto').createHmac('sha256', SESSION_SECRET).update('botauth.' + payload).digest('base64url');
  return payload + '.' + sig;
}
function verifyBotState(st) {
  try {
    const [payload, sig] = String(st || '').split('.');
    if (!payload || !sig) return null;
    const exp = require('crypto').createHmac('sha256', SESSION_SECRET).update('botauth.' + payload).digest('base64url');
    if (sig.length !== exp.length || !require('crypto').timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if ((d.k !== 'custom' && d.k !== 'connect') || !d.o || d.e < Date.now()) return null;
    return d;
  } catch { return null; }
}
app.get('/api/custom-bot-auth-link', requireAuth, (req, res) => {
  const state = signBotState(req.session.user.id);
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE_URL + '/auth/twitch/callback')}&response_type=code&scope=${encodeURIComponent('user:read:chat user:write:chat user:bot')}&state=${encodeURIComponent(state)}&force_verify=true`;
  res.json({ url });
});

// ── "Conectar mi bot": una sola autorización deja el bot listo (token de chat + insignia) ──
app.get('/api/custom-bot-connect-link', requireAuth, async (req, res) => {
  try {
    const st = await sbSelect('streamers', { twitch_id: req.session.user.id }, 'plan');
    if (!st || (st.plan !== 'pro' && st.plan !== 'admin')) return res.status(403).json({ error: 'Solo disponible en Plan Pro' });
    const state = signBotState(req.session.user.id, 'connect');
    const scopes = 'chat:read chat:edit moderator:manage:chat_messages moderator:manage:banned_users user:read:chat user:write:chat user:bot';
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE_URL + '/auth/twitch/callback')}&response_type=code&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(state)}&force_verify=true`;
    res.json({ url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function handleBotConnectCallback(req, res, code, ownerId) {
  const page = (ok, title, body) => res.status(ok ? 200 : 400).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;background:#0e0e12;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0"><div style="max-width:520px;padding:28px;background:#1a1a22;border-radius:14px;border:1px solid ${ok ? '#3ecf8e' : '#e05a7a'}"><h2 style="margin-top:0">${title}</h2>${body}<p><a style="color:#b794ff" href="/dashboard">← Volver al dashboard</a></p></div>`);
  try {
    const owner = await sbSelect('streamers', { twitch_id: ownerId }, 'twitch_username,plan,custom_bot_username');
    if (!owner || (owner.plan !== 'pro' && owner.plan !== 'admin')) return page(false, 'Solo Plan Pro', '<p>El bot personalizado es una función del Plan Pro.</p>');
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_SECRET, code, grant_type: 'authorization_code', redirect_uri: BASE_URL + '/auth/twitch/callback' }).toString()
    });
    const t = await tokenRes.json();
    if (!t.access_token || !t.refresh_token) return page(false, 'No se pudo conectar', '<p>Twitch no aceptó el código. Copia un enlace nuevo desde el dashboard e inténtalo de nuevo.</p>');
    const v = await (await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${t.access_token}` } })).json();
    const scopes = v.scopes || [];
    const missing = ['chat:read', 'chat:edit', 'moderator:manage:chat_messages', 'moderator:manage:banned_users', 'user:write:chat', 'user:bot'].filter(sc => !scopes.includes(sc));
    if (missing.length) return page(false, 'Faltaron permisos', `<p>Faltan: <code>${missing.join(', ')}</code>. Vuelve a intentarlo y acepta todos los permisos.</p>`);
    const login = String(v.login || '').toLowerCase();
    if (login === String(owner.twitch_username).toLowerCase()) {
      return page(false, 'Esa es tu cuenta', `<p>Entraste con <b>@${v.login}</b>, que es tu cuenta de streamer. Tienes que iniciar sesión con la cuenta de tu <b>bot</b> (una cuenta aparte). Copia un enlace nuevo y ábrelo en una ventana de incógnito.</p>`);
    }
    const saved = await sbUpdate('streamers', {
      custom_bot_username: v.login,
      custom_bot_token: 'oauth:' + t.access_token,
      custom_bot_refresh: t.refresh_token,
      custom_bot_expires_at: new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(),
    }, { twitch_id: ownerId });
    if (!saved || saved.code || saved.message) {
      console.error('connect-bot save:', JSON.stringify(saved));
      return page(false, 'No se pudo guardar', '<p>La autorización salió bien, pero no se pudo guardar el bot. Avisa al administrador.</p>');
    }
    await setSetting('bot_auth:' + login, { login: v.login, user_id: v.user_id, scopes, authorized_at: new Date().toISOString() });
    _ttlCache.delete('botauth');
    adminLog(req, 'bot conectado con un clic', v.login, 'owner: ' + owner.twitch_username);
    return page(true, '✅ Bot conectado', `<p>La cuenta <b>@${v.login}</b> quedó conectada a tu canal y con permiso para la insignia de bot.</p><p style="color:#9a96ad;font-size:13px">Muffet lo conecta en menos de un minuto. Recuerda dar moderador a tu bot en tu chat: <code>/mod ${v.login}</code></p>`);
  } catch (err) {
    console.error('connect bot callback:', err.message);
    return page(false, 'Error', '<p>Algo falló al conectar el bot. Inténtalo de nuevo.</p>');
  }
}

async function handleBotAuthCallback(req, res, code, kind, ownerId) {
  ownerId = ownerId || req.session?.user?.id;
  const backHref = kind === 'custom' ? '/dashboard' : '/admin';
  const backText = kind === 'custom' ? 'Volver al dashboard' : 'Volver al panel';
  const page = (ok, title, body) => res.status(ok ? 200 : 400).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;background:#0e0e12;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0"><div style="max-width:520px;padding:28px;background:#1a1a22;border-radius:14px;border:1px solid ${ok ? '#3ecf8e' : '#e05a7a'}"><h2 style="margin-top:0">${title}</h2>${body}<p><a style="color:#b794ff" href="${backHref}">← ${backText}</a></p></div>`);
  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_SECRET, code, grant_type: 'authorization_code', redirect_uri: BASE_URL + '/auth/twitch/callback' }).toString()
    });
    const t = await tokenRes.json();
    if (!t.access_token) return page(false, 'No se pudo autorizar', '<p>Twitch no aceptó el código. Intenta de nuevo desde el panel.</p>');
    const v = await (await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${t.access_token}` } })).json();
    const scopes = v.scopes || [];
    const missing = ['user:write:chat', 'user:bot'].filter(sc => !scopes.includes(sc));
    await setSetting('bot_auth:' + String(v.login).toLowerCase(), { login: v.login, user_id: v.user_id, scopes, authorized_at: new Date().toISOString() });
    _ttlCache.delete('botauth');
    adminLog(req, kind === 'custom' ? 'bot propio autorizado en la app' : 'autorizar bot en la app', v.login, missing.length ? `faltan: ${missing.join(', ')}` : 'ok');
    if (kind === 'custom') {
      const owner = await sbSelect('streamers', { twitch_id: ownerId }, 'custom_bot_username,twitch_username');
      const expected = String(owner?.custom_bot_username || '').toLowerCase();
      if (!missing.length && expected && expected !== String(v.login).toLowerCase()) {
        return page(false, 'Cuenta distinta', `<p>Autorizaste con <b>@${v.login}</b>, pero tu bot configurado es <b>@${owner.custom_bot_username}</b>. Vuelve a intentarlo y, cuando Twitch pregunte, entra con la cuenta de tu bot.</p>`);
      }
    }
    // El token recién creado no se guarda ni se usa (lo único que importa es la autorización registrada en Twitch); caduca solo.
    if (missing.length) return page(false, 'Faltaron permisos', `<p>La cuenta <b>@${v.login}</b> autorizó, pero faltan: <code>${missing.join(', ')}</code>.</p>`);
    return page(true, '✅ Bot autorizado', kind === 'custom'
      ? `<p>La cuenta <b>@${v.login}</b> ya autorizó la app de Muffet.</p><p style="color:#9a96ad;font-size:13px">Listo. El administrador activa el envío cuando esté todo preparado; tu bot sigue funcionando igual mientras tanto.</p>`
      : `<p>La cuenta <b>@${v.login}</b> ya autorizó la app de Muffet.</p><p style="color:#9a96ad;font-size:13px">Siguiente: en Railway agrega <code>HELIX_SEND=test</code> y <code>HELIX_SEND_CHANNELS=elosoking1</code>, y en tu chat escribe <code>!helixcheck</code>.</p>`);
  } catch (err) {
    console.error('bot auth callback:', err.message);
    return page(false, 'Error', '<p>Algo falló al autorizar. Revisa el log del servidor.</p>');
  }
}

app.get('/auth/twitch/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?error=auth');
  // ¿Viene del flujo "autorizar al bot"? (el state coincide con el que guardamos en tu sesión de admin)
  if (req.query.state && req.session.botAuthState && req.query.state === req.session.botAuthState) {
    delete req.session.botAuthState;
    const kind = req.session.botAuthKind || 'main'; delete req.session.botAuthKind;
    if (kind === 'channelbot') return handleChannelBotCallback(req, res, code);
    return handleBotAuthCallback(req, res, code, kind);
  }
  // Flujo con enlace firmado (ventana de incógnito, sin sesión)
  const signed = req.query.state ? verifyBotState(req.query.state) : null;
  if (signed) return signed.k === 'connect' ? handleBotConnectCallback(req, res, code, signed.o) : handleBotAuthCallback(req, res, code, 'custom', signed.o);
  // El login normal nunca lleva "state". Si llega uno que no reconocemos (enlace caducado o alterado),
  // NO iniciamos sesión ni registramos la cuenta: así una cuenta de bot nunca se crea como streamer por error.
  if (req.query.state) {
    return res.status(400).send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Enlace caducado</title><body style="font-family:system-ui,sans-serif;background:#0e0e12;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0"><div style="max-width:520px;padding:28px;background:#1a1a22;border-radius:14px;border:1px solid #e05a7a"><h2 style="margin-top:0">Enlace caducado</h2><p>Este enlace de autorización ya no es válido (dura 30 minutos). Vuelve a tu dashboard de Muffet, copia un enlace nuevo y ábrelo en una ventana de incógnito.</p><p><a style="color:#b794ff" href="/dashboard">← Volver al dashboard</a></p></div>');
  }

  try {
    const redirectUri = BASE_URL + '/auth/twitch/callback';

    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_SECRET, code, grant_type: 'authorization_code', redirect_uri: redirectUri }).toString()
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) { console.error('No token:', tokenData); return res.redirect('/?error=auth'); }

    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Client-Id': TWITCH_CLIENT_ID }
    });
    const userData = await userRes.json();
    const twitchUser = userData?.data?.[0];
    if (!twitchUser) { console.error('No user data'); return res.redirect('/?error=auth'); }
    // Si en este login el streamer dio el permiso channel:bot, lo registramos (para mostrar "Muffet autorizada" en su dashboard)
    if ((tokenData.scope || []).includes('channel:bot')) {
      const key = 'channel_bot:' + String(twitchUser.login).toLowerCase();
      getSetting(key).then(g => g || setSetting(key, { login: twitchUser.login, user_id: twitchUser.id, authorized_at: new Date().toISOString(), via: 'login' })).catch(() => {});
    }

    let streamer = await sbSelect('streamers', { twitch_id: twitchUser.id });

    // Tu cuenta es siempre admin y aprobada
    const isAdmin = twitchUser.login.toLowerCase() === 'elosoking1';

    if (!streamer) {
      streamer = await sbInsert('streamers', {
        twitch_id: twitchUser.id,
        twitch_username: twitchUser.login,
        bot_prompt: `Eres Muffet, una araña consejera con corona. Eres la consejera y asistente del canal de ${twitchUser.display_name}. Los viewers son "súbditos" o "dearies". Hablas en español, eres coqueta y misteriosa. Usas emojis 🕷️ 👑 ♥. Respuestas cortas (máximo 2 oraciones).`,
        commands: { '!miel': '🍯 ¡Miel fresca para todos! ♥', '!muffet': '🕷️ ¡Soy Muffet, consejera del canal! 👑♥', '!redes': '👑 ¡Síguenos en redes! 🕷️♥' },
        auto_messages: ['👑 ¡Recuerden seguir el canal! 🕷️♥', '🕷️ ¡Usa !ask para preguntarme! ♥'],
        ai_enabled: true, mod_enabled: false, banned_words: [],
        warn_message: '⚠️ Cuidado, dearie~ 🕷️',
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        role: isAdmin ? 'admin' : 'streamer',
        approved: true,
      });

      // Notificar nuevo registro en Discord
      if (!isAdmin && process.env.DISCORD_WEBHOOK_URL) {
        fetch(process.env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            embeds: [{
              title: '🕷️ Nuevo streamer registrado',
              description: `**${twitchUser.display_name}** acaba de unirse a MuffetBot`,
              color: 0x9147ff,
              fields: [
                { name: 'Canal', value: `[twitch.tv/${twitchUser.login}](https://twitch.tv/${twitchUser.login})`, inline: true },
                { name: 'Plan', value: '🆓 Free', inline: true },
              ],
              thumbnail: { url: twitchUser.profile_image_url },
              timestamp: new Date().toISOString(),
              footer: { text: 'MuffetBot Dashboard' }
            }]
          })
        }).catch(e => console.error('[Discord webhook]', e.message));
      }
    } else {
      await sbUpdate('streamers', { access_token: tokenData.access_token, refresh_token: tokenData.refresh_token }, { twitch_id: twitchUser.id });
    }

    if (!streamer?.id) { console.error('Streamer null'); return res.redirect('/?error=auth'); }

    req.session.user = {
      id: twitchUser.id,
      username: twitchUser.login,
      display_name: twitchUser.display_name,
      avatar: twitchUser.profile_image_url,
      streamerId: streamer.id,
      role: streamer.role || 'streamer',
      approved: streamer.approved !== false,
    };

    // Redirigir según rol
    if (!streamer.approved) return res.redirect('/pending');
    if (streamer.role === 'admin') return res.redirect('/admin');
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Auth error:', err.message);
    res.redirect('/?error=auth');
  }
});

// ── Página pública del canal ──
function proOnlyPage(res) {
  res.status(403).send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MuffetBot Pro</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><style>*{box-sizing:border-box;margin:0;padding:0;}body{background:#0d0d0f;font-family:'Inter',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;}.card{background:#141416;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px;max-width:400px;width:100%;text-align:center;}.icon{font-size:48px;margin-bottom:16px;}h1{font-size:20px;font-weight:700;color:#e8e8f0;margin-bottom:8px;}p{font-size:14px;color:#6b6b80;line-height:1.6;margin-bottom:24px;}a{display:inline-flex;align-items:center;gap:8px;background:#f0c060;color:black;font-weight:700;font-size:14px;padding:12px 24px;border-radius:24px;text-decoration:none;transition:opacity 0.15s;}a:hover{opacity:0.85;}.badge{display:inline-block;background:rgba(240,192,96,0.1);border:1px solid rgba(240,192,96,0.3);color:#f0c060;font-size:11px;font-weight:700;padding:4px 12px;border-radius:20px;margin-bottom:20px;letter-spacing:0.5px;}</style></head><body><div class="card"><div class="icon">🕷️</div><div class="badge">⭐ PLAN PRO</div><h1>Función exclusiva Pro</h1><p>Esta función está disponible para los usuarios del plan Pro de MuffetBot por solo $5/mes.</p><a href="/plans">⭐ Ver planes Pro</a></div></body></html>`);
}

app.get('/canal/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    const url = `${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${username}&approved=eq.true&limit=1`;
    const result = await fetch(url, { headers: sbHeaders });
    const data = await result.json();
    const streamer = data?.[0];
    if (!streamer) return res.status(404).send('Canal no encontrado');
    if (streamer.plan !== 'pro') return proOnlyPage(res);
    res.sendFile(path.join(__dirname, 'canal.html'));
  } catch (err) {
    res.status(500).send('Error');
  }
});

// API pública del canal
app.get('/api/canal/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    const url = `${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${username}&approved=eq.true&select=twitch_username,public_name,commands,social_links,youtube_channel_id,points_config,viewer_points,stream_schedule,primerin_config,pokedle_config,dbdle_config&limit=1`;
    const result = await fetch(url, { headers: sbHeaders });
    const data = await result.json();
    const streamer = data?.[0];
    if (!streamer) return res.status(404).json({ error: 'Canal no encontrado' });
    // Solo devolver comandos públicos (everyone)
    const publicCmds = {};
    Object.entries(streamer.commands || {}).forEach(([trigger, val]) => {
      const perms = typeof val === 'object' ? val.perms : ['everyone'];
      if (perms.includes('everyone')) {
        publicCmds[trigger] = typeof val === 'object' ? val.response : val;
      }
    });
    // Top viewers
    const pointsConfig = streamer.points_config || {};
    let topViewers = [];
    if (pointsConfig.enabled !== false && streamer.viewer_points) {
      topViewers = Object.entries(streamer.viewer_points)
        .map(([username, xp]) => ({ username, xp }))
        .sort((a, b) => b.xp - a.xp)
        .slice(0, 5);
    }

    res.json({
      username: streamer.twitch_username,
      public_name: streamer.public_name || null,
      commands: publicCmds,
      social_links: streamer.social_links || {},
      youtube_channel_id: streamer.youtube_channel_id || null,
      points_config: { name: pointsConfig.name || 'puntos', emoji: pointsConfig.emoji || '🏆', enabled: pointsConfig.enabled !== false, levels: pointsConfig.levels || [] },
      top_viewers: topViewers,
      stream_schedule: streamer.stream_schedule || null,
      primerin_config: streamer.primerin_config || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// API para verificar si fue aprobado
app.get('/api/check-approval', async (req, res) => {
  if (!req.session.user) return res.json({ approved: false });
  try {
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    if (streamer?.approved) {
      req.session.user.approved = true;
      req.session.user.role = streamer.role;
      return res.json({ approved: true, role: streamer.role });
    }
    res.json({ approved: false });
  } catch(err) { res.json({ approved: false }); }
});

// ── Página de espera para pendientes ──
app.get('/pending', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  if (req.session.user.approved) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'pending.html'));
});

// ── Panel de admin ──
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  if (req.session.user.role !== 'admin') return res.redirect('/dashboard');
  next();
}

// ── Historial de acciones del admin (tabla admin_log; si no existe, simplemente no guarda) ──
async function adminLog(req, action, target, detail) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/admin_log`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ admin: req.session?.user?.login || req.session?.user?.username || req.session?.user?.display_name || 'admin', action, target: target || null, detail: detail ? String(detail).slice(0, 300) : null })
    });
  } catch (e) { /* el historial nunca debe romper una acción */ }
}
async function patchStreamerReturning(id, body) { // PATCH que devuelve el nombre del streamer afectado (para el historial)
  const r = await fetch(`${SUPABASE_URL}/rest/v1/streamers?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { ...sbHeaders, 'Prefer': 'return=representation' }, body: JSON.stringify(body)
  });
  const rows = await r.json().catch(() => null);
  return { ok: r.ok, name: Array.isArray(rows) ? rows[0]?.twitch_username : null };
}
// ── Ajustes globales (tabla app_settings: key/value) — hoy solo el anuncio para todos los streamers ──
async function getSetting(key) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sbHeaders });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.[0]?.value || null;
  } catch (e) { return null; }
}
async function setSetting(key, value) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: 'POST', headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() })
  });
  return r.ok;
}

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// API admin — obtener todos los streamers
// Bots propios que ya autorizaron la app de Muffet (para la insignia de bot) — login en minúsculas → true
async function getBotAuthLogins() {
  return ttlCache('botauth', 30000, async () => {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=like.bot_auth:*&select=key,value`, { headers: sbHeaders });
      if (!r.ok) return {};
      const rows = await r.json();
      const out = {};
      for (const row of rows || []) {
        const sc = row?.value?.scopes || [];
        if (sc.includes('user:bot') && sc.includes('user:write:chat')) out[String(row.key).replace(/^bot_auth:/, '').toLowerCase()] = true;
      }
      return out;
    } catch (e) { return {}; }
  });
}
app.get('/api/custom-bot-status', requireAuth, async (req, res) => {
  try {
    const st = await sbSelect('streamers', { twitch_id: req.session.user.id }, 'custom_bot_username');
    const login = String(st?.custom_bot_username || '').toLowerCase();
    if (!login) return res.json({ configured: false });
    const map = await getBotAuthLogins();
    res.json({ configured: true, login: st.custom_bot_username, authorized: !!map[login] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/streamers', requireAdmin, async (req, res) => {
  try {
    const url = `${SUPABASE_URL}/rest/v1/streamers?select=id,twitch_username,twitch_id,role,approved,plan,plan_expires_at,created_at,ai_enabled,mod_enabled,custom_bot_username,commands,auto_messages,viewer_points,command_stats,bot_status,feature_flags,spotify_token,subathon_config,youtube_enabled:youtube_config->enabled&order=created_at.desc`;
    const result = await fetch(url, { headers: sbHeaders });
    const data = await result.json();
    const botAuth = await getBotAuthLogins();
    if (Array.isArray(data)) data.forEach(r => { // los tokens nunca salen del servidor: solo "está conectado o no"
      r.spotify_connected = !!r.spotify_token; delete r.spotify_token;
      r.subathon_on = !!(r.subathon_config && r.subathon_config.enabled); delete r.subathon_config;
      r.youtube_on = r.youtube_enabled === true; delete r.youtube_enabled;
      r.bot_badge = r.custom_bot_username ? !!botAuth[String(r.custom_bot_username).toLowerCase()] : null; // null = usa el bot principal
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API admin — última novedad, leída directo de dashboard.html (una sola fuente)
let _clCache = { mtime: 0, data: null };
app.get('/api/admin/changelog/latest', requireAdmin, (req, res) => {
  try {
    const file = path.join(__dirname, 'dashboard.html');
    const mtime = fs.statSync(file).mtimeMs;
    if (_clCache.data && _clCache.mtime === mtime) return res.json(_clCache.data);
    const html = fs.readFileSync(file, 'utf8');
    const m = html.match(/const update = (\{[\s\S]*?\n\s*\});\s*return/);
    if (!m) return res.status(404).json({ error: 'No se encontró la novedad en dashboard.html' });
    const u = require('vm').runInNewContext('(' + m[1] + ')', {}, { timeout: 200 });
    const data = { version: String(u.version), date: String(u.date), items: (u.items || []).map(String) };
    _clCache = { mtime, data };
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API admin — publicar novedades en Discord
app.post('/api/admin/changelog', requireAdmin, async (req, res) => {
  try {
    const webhookUrl = process.env.DISCORD_CHANGELOG_WEBHOOK;
    if (!webhookUrl) return res.status(400).json({ error: 'Webhook no configurado' });
    const { version, date, items } = req.body;
    const fields = items.map(item => ({ name: item, value: '​', inline: false }));
    const payload = {
      embeds: [{
        title: `🕷️ MuffetBot ${version} — Novedades`,
        description: `Nueva actualización disponible — ${date}`,
        color: 9519103,
        fields: items.map(item => ({ name: item, value: '​', inline: false })),
        footer: { text: `MuffetBot • ${date}` }
      }]
    };
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (r.ok || r.status === 204) { adminLog(req, 'publicar novedades', null, version); res.json({ success: true }); }
    else res.status(400).json({ error: 'Error al enviar a Discord' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// API admin — aprobar streamer
app.post('/api/admin/approve/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const r = await patchStreamerReturning(id, { approved: true, role: 'streamer' });
    adminLog(req, 'aprobar', r.name, null);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API admin — revocar acceso
app.post('/api/admin/revoke/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const target = await sbSelect('streamers', { id }, 'twitch_id');
    if (target && String(target.twitch_id) === String(req.session.user.id)) return res.status(400).json({ error: 'No puedes revocarte a ti mismo: perderías el acceso al panel' });
    const r = await patchStreamerReturning(id, { approved: false, role: 'blocked' });
    adminLog(req, 'revocar', r.name, null);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API admin — ELIMINAR una cuenta de streamer (borra fila, ajustes sueltos y archivos; devuelve un respaldo sin secretos)
app.post('/api/admin/delete/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await fetch(`${SUPABASE_URL}/rest/v1/streamers?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, { headers: sbHeaders }).then(r => r.json()).catch(() => null);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return res.status(404).json({ error: 'Cuenta no encontrada' });
    if (String(row.twitch_id) === String(req.session.user.id)) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
    if (row.role === 'admin') return res.status(400).json({ error: 'No se puede eliminar una cuenta admin. Cámbiale el rol primero' });
    const login = String(row.twitch_username || '').toLowerCase();
    const typed = String(req.body?.confirm || '').trim().toLowerCase().replace(/^@/, '');
    if (!login || typed !== login) return res.status(400).json({ error: 'Escribe el nombre del canal exactamente para confirmar' });

    // Respaldo: toda la fila, pero sin tokens ni secretos
    const backup = {};
    for (const [k, v] of Object.entries(row)) backup[k] = /token|secret|refresh|password/i.test(k) ? '[oculto]' : v;

    // 1) Borrar la fila principal (si falla, no se toca nada más)
    const del = await fetch(`${SUPABASE_URL}/rest/v1/streamers?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { ...sbHeaders, 'Prefer': 'return=minimal' } });
    if (!del.ok) return res.status(500).json({ error: 'No se pudo borrar la cuenta en la base de datos' });

    // 2) Ajustes sueltos y archivos: mejor esfuerzo (nunca rompen la respuesta)
    const keys = ['channel_bot:' + login];
    if (row.custom_bot_username) keys.push('bot_auth:' + String(row.custom_bot_username).toLowerCase());
    for (const key of keys) {
      try { await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}`, { method: 'DELETE', headers: { ...sbHeaders, 'Prefer': 'return=minimal' } }); } catch (e) {}
    }
    _ttlCache.delete('botauth');
    let files = 0;
    try {
      const lr = await fetch(`${SUPABASE_URL}/storage/v1/object/list/alerts`, { method: 'POST', headers: sbHeaders, body: JSON.stringify({ prefix: login, limit: 1000 }) });
      const list = lr.ok ? await lr.json() : [];
      const paths = (Array.isArray(list) ? list : []).filter(o => o?.name).map(o => `${login}/${o.name}`);
      if (paths.length) {
        await fetch(`${SUPABASE_URL}/storage/v1/object/alerts`, { method: 'DELETE', headers: sbHeaders, body: JSON.stringify({ prefixes: paths }) });
        files = paths.length;
      }
    } catch (e) {}

    adminLog(req, 'eliminar cuenta', row.twitch_username, files ? `${files} archivos borrados` : null);
    res.json({ success: true, name: row.twitch_username, files, backup });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API admin — cambiar rol
app.post('/api/admin/role/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    if (!['admin','streamer','pending','blocked'].includes(role)) return res.status(400).json({ error: 'Rol inválido' });
    const r = await patchStreamerReturning(id, { role, approved: role !== 'pending' && role !== 'blocked' });
    adminLog(req, 'cambiar rol', r.name, role);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
//  RUTAS PROTEGIDAS
// ══════════════════════════════════════════
app.get('/plans', (req, res) => res.sendFile(path.join(__dirname, 'plans.html')));
app.get('/guia', (req, res) => res.sendFile(path.join(__dirname, 'guia.html'))); // guía rápida para streamers nuevos (pública)
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// API admin — activar plan pro
app.post('/api/admin/plan/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { plan, expires_at } = req.body;
    if (!['free','pro'].includes(plan)) return res.status(400).json({ error: 'Plan inválido' });
    const update = { plan };
    if (plan === 'pro' && expires_at) update.plan_expires_at = expires_at;
    if (plan === 'free') { update.plan_expires_at = null; update.lemon_subscription_id = null; }
    const r = await patchStreamerReturning(id, update);
    adminLog(req, plan === 'pro' ? 'activar Pro' : 'bajar a Free', r.name, plan === 'pro' && expires_at ? `hasta ${String(expires_at).slice(0, 10)}` : null);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API admin — interruptores de funciones por canal (feature_flags)
const FLAG_THEMES = ['wolf', 'oso']; // estilos exclusivos que se pueden dar a un canal
app.post('/api/admin/flags/:id', requireAdmin, async (req, res) => {
  try {
    const f = req.body?.flags;
    if (!f || typeof f !== 'object') return res.status(400).json({ error: 'Inválido' });
    const flags = {
      dbdle: f.dbdle !== false,
      themes: Array.isArray(f.themes) ? f.themes.filter(t => FLAG_THEMES.includes(t)) : []
    };
    const r = await patchStreamerReturning(req.params.id, { feature_flags: flags });
    if (!r.ok) return res.status(400).json({ error: 'No se pudo guardar (¿falta la columna feature_flags? corre admin_mejoras.sql)' });
    adminLog(req, 'funciones del canal', r.name, `dbdle ${flags.dbdle ? 'sí' : 'no'} · estilos: ${flags.themes.join(',') || 'ninguno'}`);
    res.json({ success: true, flags });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API admin — historial de acciones
app.get('/api/admin/log', requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/admin_log?select=ts,admin,action,target,detail&order=ts.desc&limit=100`, { headers: sbHeaders });
    if (!r.ok) return res.json({ missing: true, rows: [] });
    res.json({ rows: await r.json() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Anuncio para todos los streamers (se muestra en su dashboard)
app.get('/api/admin/announcement', requireAdmin, async (req, res) => {
  res.json(await getSetting('announcement') || {});
});
app.post('/api/admin/announcement', requireAdmin, async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim().slice(0, 300);
    const value = text ? { id: Date.now(), text, ts: new Date().toISOString() } : { id: 0, text: '' };
    if (!(await setSetting('announcement', value))) return res.status(400).json({ error: 'No se pudo guardar (¿falta la tabla app_settings? corre admin_mejoras.sql)' });
    _ttlCache.delete('announcement');
    adminLog(req, text ? 'publicar anuncio' : 'quitar anuncio', null, text);
    res.json({ success: true, announcement: value });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/announcement', requireAuth, async (req, res) => {
  const a = await ttlCache('announcement', 60000, () => getSetting('announcement'));
  res.json(a && a.text ? a : {});
});

app.get('/api/streamer', requireAuth, async (req, res) => {
  try {
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    if (!streamer) return res.status(404).json({ error: 'Streamer no encontrado' });
    delete streamer.custom_bot_refresh; // el refresh token del bot nunca sale al navegador
    res.json({ streamer, user: { ...req.session.user, role: streamer.role } });
  } catch (err) {
    console.error('GET /api/streamer:', err.message);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── Exportar/Importar configuración (sin tokens ni datos sensibles) ──
const EXPORTABLE_FIELDS = [
  'shoutout_config', 'spotify_config', 'youtube_config', 'primerin_config', 'emojigame_config', 'media_alerts',
  'points_config', 'raffle_settings', 'mod_config', 'personality_prompt',
  'on_message', 'off_message', 'auto_messages', 'auto_message_interval',
  'on_off_ai', 'system_commands', 'welcome_config'
];

app.get('/api/config/export', requireAuth, async (req, res) => {
  try {
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    if (!streamer) return res.status(404).json({ error: 'Streamer no encontrado' });

    const exportData = { _muffetbot_export: true, _version: 1, _exported_at: new Date().toISOString() };
    EXPORTABLE_FIELDS.forEach(field => { if (streamer[field] !== undefined) exportData[field] = streamer[field]; });

    // Limpiar cosas específicas del canal que no deben copiarse a otro streamer
    if (exportData.shoutout_config) {
      exportData.shoutout_config = { ...exportData.shoutout_config };
      delete exportData.shoutout_config.reward_id;
      delete exportData.shoutout_config.reward_name;
    }
    if (exportData.youtube_config) {
      exportData.youtube_config = { ...exportData.youtube_config };
      delete exportData.youtube_config.queue;
      delete exportData.youtube_config.history;
      delete exportData.youtube_config.song_limits;
      delete exportData.youtube_config.player_command;
      delete exportData.youtube_config.player_command_ts;
    }
    if (exportData.primerin_config) {
      exportData.primerin_config = { ...exportData.primerin_config };
      delete exportData.primerin_config.ranking;
      delete exportData.primerin_config.used_today;
      delete exportData.primerin_config.reward_id;
      delete exportData.primerin_config.reward_name;
    }
    if (exportData.raffle_settings) {
      exportData.raffle_settings = { ...exportData.raffle_settings };
      delete exportData.raffle_settings.reward_id;
    }
    if (exportData.points_config) {
      exportData.points_config = { ...exportData.points_config }; // ranking vive aparte en viewer_points, no se exporta
    }

    res.json(exportData);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/config/import', requireAuth, async (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || incoming._muffetbot_export !== true) {
      return res.status(400).json({ error: 'Archivo inválido — no es una configuración de MuffetBot' });
    }
    const updates = {};
    EXPORTABLE_FIELDS.forEach(field => { if (incoming[field] !== undefined) updates[field] = incoming[field]; });
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No hay configuración para importar' });

    await sbUpdate('streamers', updates, { twitch_id: req.session.user.id });
    res.json({ success: true, imported: Object.keys(updates) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/on-off-ai', requireAuth, async (req, res) => {
  try {
    const { on_off_ai } = req.body;
    if (typeof on_off_ai !== 'boolean') return res.status(400).json({ error: 'Valor inválido' });
    await sbUpdate('streamers', { on_off_ai }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/on-off-messages', requireAuth, async (req, res) => {
  try {
    const { on_message, off_message } = req.body;
    await sbUpdate('streamers', { on_message: on_message || null, off_message: off_message || null }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/prompt', requireAuth, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!isValidString(prompt, 3000)) return res.status(400).json({ error: 'Prompt inválido' });
    await sbUpdate('streamers', { bot_prompt: prompt }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/prompt:', err.message);
    res.status(500).json({ error: 'Error al guardar' });
  }
});

app.post('/api/commands', requireAuth, async (req, res) => {
  try {
    const { commands } = req.body;
    if (!isValidObject(commands)) return res.status(400).json({ error: 'Comandos inválidos' });
    if (Object.keys(commands).length > 50) return res.status(400).json({ error: 'Máximo 50 comandos' });
    // Palabras sueltas (sin "!"): solo letras, números, emojis y espacios — así no rompen la página ni chocan con nada
    const PLAIN_TRIGGER = /^[\p{L}\p{N}\p{Extended_Pictographic} _-]{1,30}$/u;
    for (const [key, val] of Object.entries(commands)) {
      if (key.startsWith('!') && !/^![^\s<>"'`\\]{1,40}$/.test(key)) {
        return res.status(400).json({ error: `"${String(key).slice(0, 30)}" no es válido: sin espacios ni comillas ni < > (máx. 40)` });
      }
      if (!key.startsWith('!') && (key !== key.toLowerCase() || !PLAIN_TRIGGER.test(key))) {
        return res.status(400).json({ error: `"${String(key).slice(0, 30)}" no es válido: sin ! solo se permiten letras, números y emojis (máx. 30)` });
      }
      if (val && typeof val === 'object') {
        if (val.cooldown !== undefined && val.cooldown !== null && val.cooldown !== '') {
          const c = Number(val.cooldown);
          if (!Number.isFinite(c) || c < 0 || c > 3600) return res.status(400).json({ error: 'La espera debe estar entre 0 y 3600 segundos' });
          val.cooldown = Math.round(c);
        } else delete val.cooldown;
      }
    }
    await sbUpdate('streamers', { commands }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/commands:', err.message);
    res.status(500).json({ error: 'Error al guardar' });
  }
});

// ══════════════════════════════════════════
//  IMPORTAR comandos y mensajes automáticos desde otros bots (Nightbot, StreamElements, texto)
//  La traducción de variables vive en importer.js; aquí solo se lee, se previsualiza y se guarda ya validado.
// ══════════════════════════════════════════
let importer = null;
try { importer = require('./importer'); } catch (e) { console.error('[import] importer.js no se pudo cargar:', e.message); }
const IMPORT_MAX_CHARS = 200000;
const MAX_COMMANDS = 50, MAX_AUTOMSGS = 20;

function normalizeAutoMsgs(list) {
  return (Array.isArray(list) ? list : []).map(msg => {
    if (typeof msg === 'string') return { text: msg, type: 'fixed', interval: 20 };
    return { text: msg?.text || '', type: msg?.type || 'fixed', interval: Math.max(parseInt(msg?.interval) || 20, 5) };
  }).filter(m => m.text);
}

// ── Importar directo desde Nightbot (OAuth, solo lectura) ──
// El token se usa una sola vez para leer comandos y timers y se revoca enseguida; no se guarda.
const NIGHTBOT_CLIENT_ID = process.env.NIGHTBOT_CLIENT_ID;
const NIGHTBOT_CLIENT_SECRET = process.env.NIGHTBOT_CLIENT_SECRET;
const nightbotData = new Map(); // twitch_id -> { ts, commands, timers }
const NIGHTBOT_TTL = 15 * 60 * 1000;
setInterval(() => { const now = Date.now(); for (const [k, v] of nightbotData) if (now - v.ts > NIGHTBOT_TTL) nightbotData.delete(k); for (const [k, v] of seData) if (now - v.ts > NIGHTBOT_TTL) seData.delete(k); }, 5 * 60 * 1000).unref?.();

app.get('/auth/nightbot', requireAuth, (req, res) => {
  if (!NIGHTBOT_CLIENT_ID || !NIGHTBOT_CLIENT_SECRET) return res.redirect('/dashboard?nightbot=nocreds');
  const state = require('crypto').randomBytes(16).toString('hex');
  req.session.nbState = state;
  const url = 'https://api.nightbot.tv/oauth2/authorize?response_type=code'
    + '&client_id=' + encodeURIComponent(NIGHTBOT_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(BASE_URL + '/auth/nightbot/callback')
    + '&scope=' + encodeURIComponent('commands timers')
    + '&state=' + state;
  req.session.save(() => res.redirect(url));
});

app.get('/auth/nightbot/callback', requireAuth, async (req, res) => {
  const { code, state, error } = req.query;
  const expected = req.session.nbState;
  req.session.nbState = null;
  if (error || !code || !expected || state !== expected) return res.redirect('/dashboard?nightbot=error');
  let accessToken = null;
  try {
    const tokenRes = await fetch('https://api.nightbot.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: NIGHTBOT_CLIENT_ID, client_secret: NIGHTBOT_CLIENT_SECRET, code: String(code),
        grant_type: 'authorization_code', redirect_uri: BASE_URL + '/auth/nightbot/callback'
      }).toString()
    });
    const tok = await tokenRes.json();
    accessToken = tok.access_token;
    if (!accessToken) return res.redirect('/dashboard?nightbot=error');
    const headers = { Authorization: 'Bearer ' + accessToken };
    const [cr, tr] = await Promise.all([
      fetch('https://api.nightbot.tv/1/commands', { headers }),
      fetch('https://api.nightbot.tv/1/timers', { headers })
    ]);
    const commands = cr.ok ? JSON.stringify(await cr.json()) : '';
    const timers = tr.ok ? JSON.stringify(await tr.json()) : '';
    if (!commands && !timers) return res.redirect('/dashboard?nightbot=error');
    nightbotData.set(String(req.session.user.id), { ts: Date.now(), commands, timers });
    res.redirect('/dashboard?nightbot=ok');
  } catch (err) {
    console.error('Nightbot callback:', err.message);
    res.redirect('/dashboard?nightbot=error');
  } finally {
    if (accessToken) {
      fetch('https://api.nightbot.tv/oauth2/token/revoke', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: accessToken }).toString()
      }).catch(() => {});
    }
  }
});

app.get('/api/import/nightbot/data', requireAuth, (req, res) => {
  const d = nightbotData.get(String(req.session.user.id));
  if (!d || Date.now() - d.ts > NIGHTBOT_TTL) { nightbotData.delete(String(req.session.user.id)); return res.status(404).json({ error: 'sin_datos' }); }
  const kind = req.query.kind === 'timers' ? 'timers' : 'commands';
  const text = d[kind];
  if (!text) return res.status(404).json({ error: 'sin_datos' });
  res.json({ text });
});

// ── Importar directo desde StreamElements (OAuth, solo lectura) ──
const SE_CLIENT_ID = process.env.SE_CLIENT_ID;
const SE_CLIENT_SECRET = process.env.SE_CLIENT_SECRET;
const SE_SCOPES = process.env.SE_SCOPES || 'bot:read';
const seData = new Map(); // twitch_id -> { ts, commands, timers }

app.get('/auth/streamelements', requireAuth, (req, res) => {
  if (!SE_CLIENT_ID || !SE_CLIENT_SECRET) return res.redirect('/dashboard?streamelements=nocreds');
  const state = require('crypto').randomBytes(16).toString('hex');
  req.session.seState = state;
  const url = 'https://api.streamelements.com/oauth2/authorize?response_type=code'
    + '&client_id=' + encodeURIComponent(SE_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(BASE_URL + '/auth/streamelements/callback')
    + '&scope=' + encodeURIComponent(SE_SCOPES)
    + '&state=' + state;
  req.session.save(() => res.redirect(url));
});

app.get('/auth/streamelements/callback', requireAuth, async (req, res) => {
  const { code, state, error } = req.query;
  const expected = req.session.seState;
  req.session.seState = null;
  if (error || !code || !expected || state !== expected) return res.redirect('/dashboard?streamelements=error');
  let accessToken = null;
  try {
    const tokenRes = await fetch('https://api.streamelements.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SE_CLIENT_ID, client_secret: SE_CLIENT_SECRET, code: String(code),
        grant_type: 'authorization_code', redirect_uri: BASE_URL + '/auth/streamelements/callback'
      }).toString()
    });
    const tok = await tokenRes.json();
    accessToken = tok.access_token;
    if (!accessToken) { console.error('SE token sin access_token'); return res.redirect('/dashboard?streamelements=error'); }
    const headers = { Authorization: 'oAuth ' + accessToken };
    const vr = await fetch('https://api.streamelements.com/oauth2/validate', { headers });
    const v = await vr.json().catch(() => ({}));
    const channelId = String(v.channel_id || '').replace(/[^a-zA-Z0-9]/g, '');
    if (!channelId) { console.error('SE validate sin channel_id'); return res.redirect('/dashboard?streamelements=error'); }
    const base = 'https://api.streamelements.com/kappa/v2/bot/';
    const [cr, tr] = await Promise.all([
      fetch(base + 'commands/' + channelId, { headers }),
      fetch(base + 'timers/' + channelId, { headers })
    ]);
    if (!cr.ok) console.error('SE commands status', cr.status);
    if (!tr.ok) console.error('SE timers status', tr.status);
    const commands = cr.ok ? JSON.stringify(await cr.json()) : '';
    const timers = tr.ok ? JSON.stringify(await tr.json()) : '';
    if (!commands && !timers) return res.redirect('/dashboard?streamelements=error');
    seData.set(String(req.session.user.id), { ts: Date.now(), commands, timers });
    res.redirect('/dashboard?streamelements=ok');
  } catch (err) {
    console.error('StreamElements callback:', err.message);
    res.redirect('/dashboard?streamelements=error');
  } finally {
    if (accessToken) {
      fetch('https://api.streamelements.com/oauth2/revoke', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: SE_CLIENT_ID, client_secret: SE_CLIENT_SECRET, token: accessToken }).toString()
      }).catch(() => {});
    }
  }
});

// Con token personal (JWT): se usa una sola vez y NO se guarda ni se escribe en logs
app.post('/api/import/streamelements/token', requireAuth, async (req, res) => {
  try {
    const jwt = String(req.body?.token || '').trim();
    if (!/^[A-Za-z0-9._-]{20,4000}$/.test(jwt)) return res.status(400).json({ error: 'Ese token no parece válido' });
    const headers = { Authorization: 'Bearer ' + jwt, Accept: 'application/json' };
    const me = await fetch('https://api.streamelements.com/kappa/v2/channels/me', { headers });
    if (me.status === 401 || me.status === 403) return res.status(400).json({ error: 'StreamElements no aceptó el token. Cópialo de nuevo, completo' });
    if (!me.ok) return res.status(502).json({ error: 'StreamElements no respondió. Intenta de nuevo' });
    const channelId = String((await me.json().catch(() => ({})))._id || '').replace(/[^a-zA-Z0-9]/g, '');
    if (!channelId) return res.status(502).json({ error: 'No pude leer tu canal de StreamElements' });
    const base = 'https://api.streamelements.com/kappa/v2/bot/';
    const [cr, tr] = await Promise.all([
      fetch(base + 'commands/' + channelId, { headers }),
      fetch(base + 'timers/' + channelId, { headers })
    ]);
    if (!cr.ok) console.error('SE(token) commands status', cr.status);
    if (!tr.ok) console.error('SE(token) timers status', tr.status);
    const commands = cr.ok ? JSON.stringify(await cr.json()) : '';
    const timers = tr.ok ? JSON.stringify(await tr.json()) : '';
    if (!commands && !timers) return res.status(502).json({ error: 'No pude leer tus comandos ni timers' });
    seData.set(String(req.session.user.id), { ts: Date.now(), commands, timers });
    res.json({ ok: true });
  } catch (err) {
    console.error('SE token import:', err.message);
    res.status(500).json({ error: 'No se pudo conectar con StreamElements' });
  }
});

app.get('/api/import/streamelements/data', requireAuth, (req, res) => {
  const k = String(req.session.user.id);
  const d = seData.get(k);
  if (!d || Date.now() - d.ts > NIGHTBOT_TTL) { seData.delete(k); return res.status(404).json({ error: 'sin_datos' }); }
  const text = d[req.query.kind === 'timers' ? 'timers' : 'commands'];
  if (!text) return res.status(404).json({ error: 'sin_datos' });
  res.json({ text });
});

app.post('/api/import/preview', requireAuth, async (req, res) => {
  try {
    if (!importer) return res.status(503).json({ error: 'El importador no está disponible (falta subir importer.js al servidor)' });
    const { text, kind } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Pega primero tu lista' });
    if (text.length > IMPORT_MAX_CHARS) return res.status(400).json({ error: 'El texto es demasiado grande (máx. 200 mil caracteres)' });
    const st = await sbSelect('streamers', { twitch_id: req.session.user.id }, 'commands,auto_messages');
    if (!st) return res.status(404).json({ error: 'Cuenta no encontrada' });
    if (kind === 'timers') {
      const r = importer.parseTimers(text);
      const items = r.items.slice(0, 100).map(it => ({ ...it, selected: it.status === 'ok' || it.status === 'revisar' }));
      return res.json({ items, errors: r.errors, truncated: r.items.length > 100, meta: { current: normalizeAutoMsgs(st.auto_messages).length, limit: MAX_AUTOMSGS } });
    }
    const r = importer.parseCommands(text);
    const items = importer.annotateConflicts(r.items.slice(0, 300), st.commands || {});
    res.json({ items, errors: r.errors, truncated: r.items.length > 300, meta: { current: Object.keys(st.commands || {}).length, limit: MAX_COMMANDS } });
  } catch (err) {
    console.error('POST /api/import/preview:', err.message);
    res.status(500).json({ error: 'No se pudo analizar la lista' });
  }
});

app.post('/api/import/apply', requireAuth, async (req, res) => {
  try {
    if (!importer) return res.status(503).json({ error: 'El importador no está disponible (falta subir importer.js al servidor)' });
    const { kind, items } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No hay nada seleccionado' });
    if (items.length > 100) return res.status(400).json({ error: 'Importa como máximo 100 a la vez' });
    const st = await sbSelect('streamers', { twitch_id: req.session.user.id }, 'commands,auto_messages');
    if (!st) return res.status(404).json({ error: 'Cuenta no encontrada' });

    if (kind === 'timers') {
      const current = normalizeAutoMsgs(st.auto_messages);
      const seen = new Set(current.map(m => m.text.toLowerCase()));
      const additions = [], errors = [];
      for (const it of items) {
        const v = importer.sanitizeTimer(it);
        if (!v.ok) { errors.push(v.error); continue; }
        if (seen.has(v.value.text.toLowerCase())) continue; // ya lo tienes
        seen.add(v.value.text.toLowerCase());
        additions.push(v.value);
      }
      if (errors.length) return res.status(400).json({ error: errors[0] + (errors.length > 1 ? ` (y ${errors.length - 1} más)` : ''), errors });
      const merged = current.concat(additions);
      if (merged.length > MAX_AUTOMSGS) return res.status(400).json({ error: `Máximo ${MAX_AUTOMSGS} mensajes automáticos: tienes ${current.length} y quieres añadir ${additions.length}` });
      await sbUpdate('streamers', { auto_messages: merged }, { twitch_id: req.session.user.id });
      return res.json({ success: true, imported: additions.length, skipped: items.length - additions.length, auto_messages: merged });
    }

    const cmds = { ...(st.commands || {}) };
    let imported = 0, replaced = 0, skipped = 0;
    const errors = [];
    for (const it of items) {
      const v = importer.sanitizeCommand(it);
      if (!v.ok) { errors.push(v.error); continue; }
      if (cmds[v.name] !== undefined && !it.replace) { skipped++; continue; }
      if (cmds[v.name] !== undefined) replaced++; else imported++;
      cmds[v.name] = v.value;
    }
    if (errors.length) return res.status(400).json({ error: errors[0] + (errors.length > 1 ? ` (y ${errors.length - 1} más)` : ''), errors });
    if (Object.keys(cmds).length > MAX_COMMANDS) return res.status(400).json({ error: `Máximo ${MAX_COMMANDS} comandos: tienes ${Object.keys(st.commands || {}).length} y al importar tendrías ${Object.keys(cmds).length}. Desmarca algunos.` });
    await sbUpdate('streamers', { commands: cmds }, { twitch_id: req.session.user.id });
    res.json({ success: true, imported, replaced, skipped, total: Object.keys(cmds).length, commands: cmds });
  } catch (err) {
    console.error('POST /api/import/apply:', err.message);
    res.status(500).json({ error: 'No se pudo importar' });
  }
});

app.post('/api/auto-messages', requireAuth, async (req, res) => {
  try {
    const { auto_messages } = req.body;
    if (!isValidArray(auto_messages)) return res.status(400).json({ error: 'Mensajes inválidos' });
    if (auto_messages.length > 20) return res.status(400).json({ error: 'Máximo 20 mensajes' });
    // Migrar formato antiguo (string) a nuevo (objeto)
    const normalized = auto_messages.map(msg => {
      if (typeof msg === 'string') return { text: msg, type: 'fixed', interval: 20 };
      return { text: msg.text || '', type: msg.type || 'fixed', interval: Math.max(parseInt(msg.interval) || 20, 5) };
    }).filter(m => m.text);
    await sbUpdate('streamers', { auto_messages: normalized }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/auto-messages:', err.message);
    res.status(500).json({ error: 'Error al guardar' });
  }
});

// API — guardar bot personalizado (solo Pro)
app.post('/api/custom-bot', requireAuth, async (req, res) => {
  try {
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    if (!streamer || (streamer.plan !== 'pro' && streamer.plan !== 'admin')) {
      return res.status(403).json({ error: 'Solo disponible en Plan Pro' });
    }
    const { custom_bot_username, custom_bot_token } = req.body;
    if (!custom_bot_username || !custom_bot_token) return res.status(400).json({ error: 'Faltan datos' });
    if (!custom_bot_token.startsWith('oauth:')) return res.status(400).json({ error: 'Token inválido' });
    let up = await sbUpdate('streamers', { custom_bot_username, custom_bot_token, custom_bot_refresh: null, custom_bot_expires_at: null }, { twitch_id: req.session.user.id });
    if (up && (up.code || up.message)) up = await sbUpdate('streamers', { custom_bot_username, custom_bot_token }, { twitch_id: req.session.user.id }); // por si aún no se corrió conectar_bot.sql
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API — eliminar bot personalizado
app.delete('/api/custom-bot', requireAuth, async (req, res) => {
  try {
    const up = await sbUpdate('streamers', { custom_bot_username: null, custom_bot_token: null, custom_bot_refresh: null, custom_bot_expires_at: null }, { twitch_id: req.session.user.id });
    if (up && (up.code || up.message)) await sbUpdate('streamers', { custom_bot_username: null, custom_bot_token: null }, { twitch_id: req.session.user.id }); // por si aún no se corrió conectar_bot.sql
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API Stream Manager ──
// ── EventSub de Twitch ──
const crypto = require('crypto');

function verifyTwitchSignature(req) {
  const msgId = req.headers['twitch-eventsub-message-id'];
  const timestamp = req.headers['twitch-eventsub-message-timestamp'];
  const signature = req.headers['twitch-eventsub-message-signature'];
  if (!msgId || !timestamp || !signature) return false;
  const hmac = 'sha256=' + crypto.createHmac('sha256', EVENTSUB_SECRET)
    .update(msgId + timestamp + req.body)
    .digest('hex');
  return hmac === signature;
}

app.post('/webhook/twitch', (req, res) => {
  if (!verifyTwitchSignature(req)) return res.status(403).send('Forbidden');
  const body = JSON.parse(req.body.toString());
  const type = req.headers['twitch-eventsub-message-type'];
  if (type === 'webhook_callback_verification') return res.status(200).send(body.challenge);
  if (type === 'notification') {
    const eventType = body.subscription?.type;
    const event = body.event;

    // Manejar canje de puntos para sorteo
    if (eventType === 'channel.channel_points_custom_reward_redemption.add') {
      handleRewardRedemption(event).catch(e => console.error('[redemption]', e.message));
    }

    // Enviar evento al bot para otros eventos
    const botUrl = `${process.env.BOT_URL || 'http://localhost:' + (process.env.BOT_PORT || 3001)}/event`;
    fetch(botUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.BOT_SECRET || 'muffetbot-internal-2026', type: eventType, event })
    }).catch(() => {});
  }
  res.status(204).send();
});

// ══════════════════════════════════════════
//  MEDIA ALERTS — audio/video al canjear puntos del canal
//  El server solo empuja el aviso por SSE; el overlay carga el archivo directo desde Supabase Storage (CDN)
// ══════════════════════════════════════════
const alertConnections = {}; // { channelName: Set<res> } — overlays conectados por SSE

function pushMediaAlert(channelName, alert) {
  const conns = alertConnections[channelName];
  if (!conns || !conns.size) { console.log(`[media-alerts] Sin overlays conectados en #${channelName}`); return false; }
  const payload = `data: ${JSON.stringify(alert)}\n\n`;
  conns.forEach(res => { try { res.write(payload); } catch(e) {} });
  console.log(`[media-alerts] Alerta enviada a ${conns.size} overlay(s) de #${channelName}`);
  return true;
}

// SSE — el overlay se conecta aquí y queda escuchando
app.get('/api/media-alerts/events/:username', (req, res) => {
  const channelName = req.params.username?.toLowerCase();
  if (!channelName) return res.status(400).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('data: {"type":"connected"}\n\n');
  if (!alertConnections[channelName]) alertConnections[channelName] = new Set();
  alertConnections[channelName].add(res);
  const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch(e) {} }, 25000);
  req.on('close', () => {
    clearInterval(keepalive);
    alertConnections[channelName]?.delete(res);
  });
});

// Subir archivo de audio/video a Supabase Storage (base64, máx 15MB — suficiente para clips de hasta ~40-50s)
const MEDIA_ALERT_TYPES = { 'audio/mpeg':'mp3', 'audio/ogg':'ogg', 'audio/wav':'wav', 'video/mp4':'mp4', 'video/webm':'webm' };
const MEDIA_ALERT_MAX_BYTES = 15 * 1024 * 1024;
let alertsBucketReady = false;

async function ensureAlertsBucket() {
  if (alertsBucketReady) return;
  try {
    const created = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: 'POST', headers: { ...sbHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'alerts', name: 'alerts', public: true, file_size_limit: MEDIA_ALERT_MAX_BYTES })
    });
    if (!created.ok) {
      // Ya existía (posiblemente con el límite viejo de 5MB) — actualizarlo
      await fetch(`${SUPABASE_URL}/storage/v1/bucket/alerts`, {
        method: 'PUT', headers: { ...sbHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ public: true, file_size_limit: MEDIA_ALERT_MAX_BYTES })
      }).catch(() => {});
    }
  } catch(e) {}
  alertsBucketReady = true;
}

app.post('/api/media-alerts/upload', requireAuth, express.json({ limit: '21mb' }), async (req, res) => {
  try {
    const { filename, mime, data } = req.body;
    if (!filename || !mime || !data) return res.status(400).json({ error: 'Datos incompletos' });
    const ext = MEDIA_ALERT_TYPES[mime];
    if (!ext) return res.status(400).json({ error: 'Formato no soportado — usa MP3, OGG, WAV, MP4 o WebM' });
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length > MEDIA_ALERT_MAX_BYTES) return res.status(400).json({ error: 'El archivo supera los 15MB' });

    await ensureAlertsBucket();
    const channelName = req.session.user.username?.toLowerCase() || req.session.user.id;
    const safeName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`.slice(0, 80);
    const path = `${channelName}/${safeName}`;

    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/alerts/${path}`, {
      method: 'POST', headers: { ...sbHeaders, 'Content-Type': mime, 'x-upsert': 'true' },
      body: buffer
    });
    if (!up.ok) {
      const err = await up.text();
      console.error('[media-alerts] Upload error:', up.status, err.slice(0, 200));
      return res.status(500).json({ error: 'Error al subir el archivo' });
    }
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/alerts/${path}`;
    res.json({ success: true, url: publicUrl, type: mime.startsWith('video') ? 'video' : 'audio' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Guardar configuración de media alerts
app.post('/api/media-alerts', requireAuth, async (req, res) => {
  try {
    const { media_alerts } = req.body;
    if (!isValidObject(media_alerts)) return res.status(400).json({ error: 'Inválido' });
    if (Array.isArray(media_alerts.alerts) && media_alerts.alerts.length > 20) {
      return res.status(400).json({ error: 'Máximo 20 alertas por canal' });
    }
    await sbUpdate('streamers', { media_alerts }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Probar una alerta desde el dashboard
app.post('/api/media-alerts/test', requireAuth, async (req, res) => {
  try {
    const { url, type, volume } = req.body;
    const channelName = req.session.user.username?.toLowerCase();
    pushMediaAlert(channelName, { type: 'alert', media_url: url, media_type: type, volume: volume ?? 80, redeemer: 'Prueba' });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Servir el overlay
app.get('/overlay/alerts/:username', (req, res) => {
  res.sendFile(path.join(__dirname, 'media-alerts-overlay.html'));
});

// ══════════════════════════════════════════
//  RECOMPENSAS DE PUNTOS DE CANAL — crearlas desde Muffet y resolver sus canjes
//  Twitch solo deja que una app administre las recompensas que ELLA misma creó (mismo Client-Id).
//  Por eso solo las recompensas creadas por Muffet se pueden cumplir/reembolsar automáticamente.
// ══════════════════════════════════════════

// Una recompensa está "administrada por Muffet" si es la misma que Muffet creó para esa función
function isManagedReward(cfg) {
  return !!(cfg && cfg.reward_id && cfg.reward_id === cfg.managed_reward_id);
}

async function createTwitchReward(streamer, { title, cost, cooldownSec = 0, maxPerStream = 0 }) {
  const token = await getFreshTwitchToken(streamer);
  if (!token) return { ok: false, status: 401, message: 'sin token' };
  const body = {
    title, cost,
    is_enabled: true,
    background_color: '#8B5CF6',
    // Deben quedar pendientes para que Muffet los pueda cumplir o reembolsar él mismo
    should_redemptions_skip_request_queue: false,
  };
  if (cooldownSec > 0) { body.is_global_cooldown_enabled = true; body.global_cooldown_seconds = cooldownSec; }
  if (maxPerStream > 0) { body.is_max_per_stream_enabled = true; body.max_per_stream = maxPerStream; }
  const r = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${streamer.twitch_id}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, message: data.message || data.error || '' };
  const reward = data.data?.[0];
  if (!reward) return { ok: false, status: 502, message: 'Twitch no devolvió la recompensa' };
  return { ok: true, reward: { id: reward.id, title: reward.title, cost: reward.cost, image: reward.image?.url_1x || reward.default_image?.url_1x || '' } };
}

function friendlyRewardError(status, message) {
  const msg = String(message || '');
  if (status === 401) return 'Tu sesión de Twitch no tiene permiso para crear recompensas — cierra sesión y vuelve a entrar con Twitch.';
  if (status === 403) return 'Tu canal necesita ser afiliado o partner de Twitch para tener recompensas de puntos.';
  if (/DUPLICATE/i.test(msg)) return 'Ya tienes una recompensa con ese nombre — elige otro.';
  if (/TOO_MANY|maximum/i.test(msg)) return 'Llegaste al máximo de recompensas de Twitch (50) — borra alguna que no uses.';
  return `Twitch no pudo crear la recompensa${msg ? `: ${msg}` : ''}`;
}

// Cumple (FULFILLED) o cancela (CANCELED → Twitch devuelve los puntos al viewer) un canje pendiente.
// Si la recompensa no la creó Muffet, Twitch responde 403 y simplemente no se hace nada.
async function settleRedemption(streamer, rewardId, redemptionId, status) {
  if (!redemptionId) return false;
  try {
    const token = await getFreshTwitchToken(streamer);
    if (!token) return false;
    const r = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?id=${redemptionId}&broadcaster_id=${streamer.twitch_id}&reward_id=${rewardId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!r.ok) { console.error(`[redemption] No se pudo marcar ${status} (${r.status}):`, (await r.text()).slice(0, 200)); return false; }
    console.log(`[redemption] Canje ${redemptionId} → ${status}`);
    return true;
  } catch(e) { console.error('[redemption] settleRedemption error:', e.message); return false; }
}

app.post('/api/rewards/create', requireAuth, async (req, res) => {
  try {
    const { purpose, title, cost, cooldown_sec } = req.body || {};
    if (!['raffle', 'primerin', 'media'].includes(purpose)) return res.status(400).json({ error: 'Propósito inválido' });
    const cleanTitle = String(title || '').trim();
    const cleanCost = parseInt(cost);
    const cooldown = Math.max(0, parseInt(cooldown_sec) || 0);
    if (!cleanTitle || cleanTitle.length > 45) return res.status(400).json({ error: 'El nombre debe tener entre 1 y 45 caracteres.' });
    if (!Number.isInteger(cleanCost) || cleanCost < 1 || cleanCost > 1000000) return res.status(400).json({ error: 'El costo debe ser de 1 punto o más.' });
    if (cooldown > 604800) return res.status(400).json({ error: 'El enfriamiento no puede pasar de 7 días.' });

    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    if (!streamer) return res.status(404).json({ error: 'Streamer no encontrado' });

    // Primerin: límite de 1 canje por stream, así solo gana el primero (Muffet confía en ese límite de Twitch)
    const result = await createTwitchReward(streamer, {
      title: cleanTitle, cost: cleanCost, cooldownSec: cooldown,
      maxPerStream: purpose === 'primerin' ? 1 : 0,
    });
    if (!result.ok) {
      console.error(`[rewards] No se pudo crear la recompensa para ${streamer.twitch_username}: ${result.status} ${result.message}`);
      return res.status(result.status === 401 || result.status === 403 ? result.status : 400).json({ error: friendlyRewardError(result.status, result.message) });
    }
    console.log(`[rewards] ${streamer.twitch_username} creó la recompensa "${result.reward.title}" (${purpose})`);
    res.json({ success: true, reward: result.reward });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

async function handleRewardRedemption(event) {
  const broadcasterId = event.broadcaster_user_id;
  const rewardId = event.reward?.id;
  const username = event.user_name;
  const redemptionId = event.id; // id del canje (para cumplirlo o reembolsarlo)
  if (!broadcasterId || !rewardId || !username) return;

  // Buscar el streamer por twitch_id
  const res = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_id=eq.${broadcasterId}&limit=1`, { headers: sbHeaders });
  const data = await res.json();
  const streamer = data?.[0];
  if (!streamer) return;

  const channelName = streamer.twitch_username?.toLowerCase();

  // ── Media Alert (audio/video en overlay) ──
  const mediaAlerts = streamer.media_alerts || {};
  if (mediaAlerts.enabled !== false && Array.isArray(mediaAlerts.alerts)) {
    const matched = mediaAlerts.alerts.find(a => a.reward_id === rewardId && a.media_url);
    if (matched) {
      const isProMedia = streamer.plan === 'pro' || streamer.plan === 'admin';
      let delivered = false;
      if (isProMedia) {
        delivered = pushMediaAlert(channelName, { type: 'alert', media_url: matched.media_url, media_type: matched.media_type || 'audio', volume: matched.volume ?? 80, redeemer: username });
        console.log(`[media-alerts] ${username} disparó "${matched.name || 'alerta'}" en #${channelName}`);
      }
      // Recompensa creada por Muffet: se cumple si la alerta llegó a un overlay; si no, se reembolsa
      if (isManagedReward({ reward_id: matched.reward_id, managed_reward_id: matched.managed_reward_id })) {
        await settleRedemption(streamer, rewardId, redemptionId, delivered ? 'FULFILLED' : 'CANCELED');
      }
      return;
    }
  } else if (Array.isArray(mediaAlerts.alerts)) {
    // Alertas desactivadas: si la recompensa la administra Muffet, se reembolsa en vez de quitarle los puntos al viewer
    const offAlert = mediaAlerts.alerts.find(a => a.reward_id === rewardId && isManagedReward({ reward_id: a.reward_id, managed_reward_id: a.managed_reward_id }));
    if (offAlert) { await settleRedemption(streamer, rewardId, redemptionId, 'CANCELED'); return; }
  }

  const configuredRaffleReward = streamer.raffle_settings?.reward_id;
  const primerinConfig = streamer.primerin_config || {};
  const configuredPrimerinReward = primerinConfig.mode === 'reward' ? primerinConfig.reward_id : null;
  const primerinManaged = isManagedReward(primerinConfig);
  const raffleManaged = isManagedReward(streamer.raffle_settings);

  console.log(`[redemption] ${username} canjeó ${rewardId} en #${channelName} | sorteo: ${configuredRaffleReward||'ninguno'} | primerin: ${configuredPrimerinReward||'ninguno'}`);

  // ── Canje de Primerin ──
  if (configuredPrimerinReward && rewardId === configuredPrimerinReward) {
    const isPro = streamer.plan === 'pro' || streamer.plan === 'admin';
    if (!isPro) {
      console.log(`[redemption] #${channelName} no es Pro — Primerin ignorado`);
      if (primerinManaged) await settleRedemption(streamer, rewardId, redemptionId, 'CANCELED');
      return;
    }

    const today = new Date().toISOString().split('T')[0];
    const usedToday = primerinConfig.used_today || {};
    // En modo canje confiamos en el límite de Twitch (Max redemptions per stream)
    const ranking = primerinConfig.ranking || {};
    ranking[username.toLowerCase()] = (ranking[username.toLowerCase()] || 0) + 1;
    const newConfig = { ...primerinConfig, ranking, used_today: { date: today, winner: username } };

    await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_id=eq.${broadcasterId}`, {
      method: 'PATCH', headers: { ...sbHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ primerin_config: newConfig })
    });

    console.log(`[redemption] ✅ ${username} ganó Primerin en #${channelName} (${ranking[username.toLowerCase()]} victorias)`);

    const botUrl = `${process.env.BOT_URL || 'http://localhost:' + (process.env.BOT_PORT || 3001)}/event`;
    console.log(`[redemption] Notificando al bot en: ${botUrl}`);
    fetch(botUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: process.env.BOT_SECRET || 'muffetbot-internal-2026',
        type: 'primerin.redemption',
        event: { channel: channelName, username, wins: ranking[username.toLowerCase()], message: primerinConfig.message || '' }
      })
    }).then(r => console.log(`[redemption] Bot respondió status: ${r.status}`))
      .catch(e => console.error('[redemption] Error al notificar al bot:', e.message));
    if (primerinManaged) await settleRedemption(streamer, rewardId, redemptionId, 'FULFILLED');
    return;
  }

  // Primerin en modo comando pero con su recompensa todavía activa en Twitch: si la administra Muffet, se reembolsa
  if (primerinConfig.reward_id && rewardId === primerinConfig.reward_id && rewardId !== configuredRaffleReward && primerinConfig.mode !== 'reward') {
    console.log(`[redemption] Primerin de #${channelName} está en modo comando — canje de ${username} ignorado`);
    if (primerinManaged) await settleRedemption(streamer, rewardId, redemptionId, 'CANCELED');
    return;
  }

  if (!configuredRaffleReward || rewardId !== configuredRaffleReward) return;

  // Si el sorteo está configurado para entrar solo por comando, los canjes no cuentan
  if (streamer.raffle_settings?.entry_mode === 'command') {
    console.log(`[redemption] Sorteo de #${channelName} está en modo comando — canje de ${username} ignorado`);
    if (raffleManaged) await settleRedemption(streamer, rewardId, redemptionId, 'CANCELED');
    return;
  }

  // Verificar que hay sorteo activo
  const raffle = streamer.raffle_active || {};
  if (!raffle.active) {
    console.log(`[redemption] Sorteo no activo en #${channelName}`);
    if (raffleManaged) await settleRedemption(streamer, rewardId, redemptionId, 'CANCELED');
    return;
  }

  const participants = raffle.participants || [];
  if (participants.includes(username)) {
    console.log(`[redemption] ${username} ya está en el sorteo`);
    if (raffleManaged) await settleRedemption(streamer, rewardId, redemptionId, 'CANCELED');
    return;
  }

  participants.push(username);
  await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_id=eq.${broadcasterId}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raffle_active: { ...raffle, participants } })
  });

  console.log(`[redemption] ✅ ${username} agregado al sorteo de #${channelName} (${participants.length} participantes)`);
  if (raffleManaged) await settleRedemption(streamer, rewardId, redemptionId, 'FULFILLED');

  // Notificar en el chat via bot
  const botUrl = `${process.env.BOT_URL || 'http://localhost:' + (process.env.BOT_PORT || 3001)}/event`;
  fetch(botUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: process.env.BOT_SECRET || 'muffetbot-internal-2026',
      type: 'raffle.redemption',
      event: { channel: channelName, username, count: participants.length }
    })
  }).catch(() => {});
}

async function getTwitchAppToken() {
  const res = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_SECRET}&grant_type=client_credentials`, { method: 'POST' });
  const data = await res.json();
  return data.access_token;
}

// Solo se registran por EventSub las alertas que el bot realmente usa por ese camino.
// Subs, regalos de subs y bits el bot los recibe directo del chat (tmi.js), no por EventSub —
// registrarlos aquí exigiría permisos extra (channel:read:subscriptions, bits:read) y no aportaría nada.
const EVENTSUB_LABELS = {
  'channel.follow': 'Seguidores',
  'channel.channel_points_custom_reward_redemption.add': 'Canjes de puntos',
};

// Registra las alertas en Twitch y devuelve qué pasó con cada una (ok / ya estaba activa / falló)
async function registerEventSub(broadcasterId, appToken) {
  const webhookUrl = `${BASE_URL}/webhook/twitch`;
  const subs = [
    { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId } },
    { type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: { broadcaster_user_id: broadcasterId } },
  ];
  const results = [];
  for (const sub of subs) {
    const label = EVENTSUB_LABELS[sub.type] || sub.type;
    try {
      const r = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${appToken}`, 'Client-Id': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sub, transport: { method: 'webhook', callback: webhookUrl, secret: EVENTSUB_SECRET } })
      });
      if (r.status === 202 || r.ok) { results.push({ type: sub.type, label, status: 'ok' }); continue; }
      if (r.status === 409) { results.push({ type: sub.type, label, status: 'exists' }); continue; } // ya estaba registrada
      const data = await r.json().catch(() => ({}));
      const message = data.message || data.error || `HTTP ${r.status}`;
      console.error(`[eventsub] ${sub.type} rechazada por Twitch (${r.status}): ${message}`);
      results.push({ type: sub.type, label, status: 'failed', message });
    } catch(e) {
      console.error(`[eventsub] ${sub.type} error de red: ${e.message}`);
      results.push({ type: sub.type, label, status: 'failed', message: e.message });
    }
  }
  return results;
}

app.post('/api/eventsub/register', requireAuth, async (req, res) => {
  try {
    const appToken = await getTwitchAppToken();
    if (!appToken) return res.status(502).json({ error: 'No se pudo conectar con Twitch' });
    const results = await registerEventSub(req.session.user.id, appToken);
    const failed = results.filter(r => r.status === 'failed');
    res.json({ success: failed.length === 0, results, failed: failed.length });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── API Horario ──
app.post('/api/schedule', requireAuth, async (req, res) => {
  try {
    const { stream_schedule } = req.body;
    await sbUpdate('streamers', { stream_schedule }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Refrescar/obtener un access_token de Twitch válido para un streamer ──
async function refreshTwitchToken(twitchId, refreshToken) {
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: refreshToken,
        client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_SECRET,
      }).toString()
    });
    const data = await res.json();
    if (!data.access_token) { console.error('[twitch-refresh] Sin access_token:', JSON.stringify(data)); return null; }
    await sbUpdate('streamers', { access_token: data.access_token, refresh_token: data.refresh_token || refreshToken }, { twitch_id: twitchId });
    return data.access_token;
  } catch(e) { console.error('[twitch-refresh] error:', e.message); return null; }
}

async function getFreshTwitchToken(streamer) {
  if (!streamer?.access_token) return null;
  const check = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { 'Authorization': `Bearer ${streamer.access_token}` } });
  if (check.ok) return streamer.access_token;
  if (!streamer.refresh_token) return null;
  return refreshTwitchToken(streamer.twitch_id, streamer.refresh_token);
}

// ── API Último clip ──
app.get('/api/clips/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    const url = `${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${username}&approved=eq.true&select=twitch_id,access_token,refresh_token&limit=1`;
    const result = await fetch(url, { headers: sbHeaders });
    const data = await result.json();
    const streamer = data?.[0];
    const token = await getFreshTwitchToken(streamer);
    if (!token) return res.json([]);

    const r = await fetch(`https://api.twitch.tv/helix/clips?broadcaster_id=${streamer.twitch_id}&first=4`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID }
    });
    const clipData = await r.json();
    const clips = (clipData.data || []).map(c => ({
      id: c.id, title: c.title,
      url: c.url, thumbnail: c.thumbnail_url,
      views: c.view_count, created: c.created_at,
      duration: Math.round(c.duration)
    }));
    res.json(clips);
  } catch(err) { res.json([]); }
});
app.get('/overlay/spotify/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    const url = `${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${username}&approved=eq.true&select=plan&limit=1`;
    const result = await fetch(url, { headers: sbHeaders });
    const data = await result.json();
    if (!data?.[0] || (data[0].plan !== 'pro' && data[0].plan !== 'admin')) return proOnlyPage(res);
    res.sendFile(path.join(__dirname, 'spotify-overlay.html'));
  } catch(err) { res.status(500).send('Error'); }
});

app.get('/api/overlay/spotify/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    // Varios overlays/pestañas abiertos comparten una consulta cada 4 s (cuida a Supabase y los límites de Spotify)
    const { payload, ts } = await ttlCache('spotify:' + username, 4000, async () => {
      const streamer = await sbSelect('streamers', { twitch_username: username }, 'spotify_token,spotify_refresh,spotify_client_id,spotify_client_secret,spotify_config');
      if (!streamer?.spotify_token) return { payload: { playing: false }, ts: Date.now() };

      let token = streamer.spotify_token;
      let r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (r.status === 401 && streamer.spotify_refresh) {
        token = await refreshSpotifyToken(streamer.spotify_refresh, streamer.spotify_client_id, streamer.spotify_client_secret);
        if (token) {
          await sbUpdate('streamers', { spotify_token: token }, { twitch_username: username });
          r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', { headers: { 'Authorization': `Bearer ${token}` } });
        }
      }
      if (r.status === 204 || !r.ok) return { payload: { playing: false }, ts: Date.now() };
      const data = await r.json();
      if (!data.item) return { payload: { playing: false }, ts: Date.now() };
      return {
        ts: Date.now(),
        payload: {
          playing: true,
          track: data.item.name,
          artist: data.item.artists.map(a => a.name).join(', '),
          album: data.item.album.name,
          image: data.item.album.images?.[1]?.url || data.item.album.images?.[0]?.url || '',
          progress_ms: data.progress_ms,
          duration_ms: data.item.duration_ms,
          is_playing: data.is_playing,
          overlay_opacity: streamer.spotify_config?.overlay_opacity ?? 100,
          bg_opacity: streamer.spotify_config?.bg_opacity ?? 75,
          theme: streamer.spotify_config?.theme || 'classic',
          layout: streamer.spotify_config?.layout === 'vertical' ? 'vertical' : 'horizontal',
          cover: streamer.spotify_config?.cover === 'disc' ? 'disc' : 'square'
        }
      };
    });
    // Si la respuesta viene de la caché, el progreso se adelanta lo que pasó desde que se leyó
    if (payload.playing && payload.is_playing) {
      const elapsed = Date.now() - ts;
      return res.json({ ...payload, progress_ms: Math.min((payload.progress_ms || 0) + elapsed, payload.duration_ms || Infinity) });
    }
    res.json(payload);
  } catch(err) { res.json({ playing: false }); }
});

app.post('/api/youtube-music', requireAuth, async (req, res) => {
  try {
    const { youtube_music_config } = req.body;
    if (!isValidObject(youtube_music_config)) return res.status(400).json({ error: 'Inválido' });
    await sbUpdate('streamers', { youtube_music_config }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── LEMON SQUEEZY CHECKOUT ──
app.post('/api/checkout', requireAuth, async (req, res) => {
  try {
    const { variant_id } = req.body;
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    if (!streamer) return res.status(404).json({ error: 'Streamer no encontrado' });

    const validVariants = [
      process.env.LEMONSQUEEZY_VARIANT_MONTHLY,
      process.env.LEMONSQUEEZY_VARIANT_QUARTERLY,
      process.env.LEMONSQUEEZY_VARIANT_BIANNUAL,
      process.env.LEMONSQUEEZY_VARIANT_ANNUAL,
    ];
    if (!validVariants.includes(String(variant_id))) return res.status(400).json({ error: 'Plan inválido' });

    const checkoutRes = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`,
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/vnd.api+json',
      },
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              custom: { twitch_id: String(req.session.user.id) },
            },
            product_options: {
              redirect_url: `https://muffet-dashboard.onrender.com/dashboard?upgraded=1`,
            },
          },
          relationships: {
            store: { data: { type: 'stores', id: String(process.env.LEMONSQUEEZY_STORE_ID) } },
            variant: { data: { type: 'variants', id: String(variant_id) } },
          },
        },
      }),
    });

    const checkoutData = await checkoutRes.json();
    console.log('[LS Checkout]', JSON.stringify(checkoutData).slice(0,500));
    const url = checkoutData.data?.attributes?.url;
    if (!url) return res.status(500).json({ error: 'No se pudo crear el checkout' });
    res.json({ url });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cancel-subscription', requireAuth, async (req, res) => {
  try {
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    if (!streamer?.lemon_subscription_id) return res.status(400).json({ error: 'No tienes suscripción activa' });

    await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${streamer.lemon_subscription_id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`, 'Accept': 'application/vnd.api+json' },
    });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mod-config', requireAuth, async (req, res) => {
  try {
    const { mod_config } = req.body;
    await sbUpdate('streamers', { mod_config }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/live-announcement', requireAuth, async (req, res) => {
  try {
    const { live_announcement } = req.body;
    if (!isValidObject(live_announcement)) return res.status(400).json({ error: 'Inválido' });
    await sbUpdate('streamers', { live_announcement }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reset-command-stats', requireAuth, async (req, res) => {
  try {
    await sbUpdate('streamers', { command_stats: {} }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/points-clean-broadcaster', requireAuth, async (req, res) => {
  try {
    const username = req.session.user.username.toLowerCase();
    const result = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_id=eq.${req.session.user.id}&select=viewer_points`, { headers: sbHeaders });
    const data = await result.json();
    const viewer_points = data?.[0]?.viewer_points || {};
    delete viewer_points[username];
    await sbUpdate('streamers', { viewer_points }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/primerin', requireAuth, async (req, res) => {
  try {
    const { primerin_config } = req.body;
    if (!isValidObject(primerin_config)) return res.status(400).json({ error: 'Inválido' });
    await sbUpdate('streamers', { primerin_config }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/emojigame', requireAuth, async (req, res) => {
  try {
    const { emojigame_config } = req.body;
    if (!isValidObject(emojigame_config)) return res.status(400).json({ error: 'Inválido' });
    await sbUpdate('streamers', { emojigame_config }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Subatón ──
// Estilos del overlay del subatón. wolf/oso son exclusivos (se pueden habilitar a otros canales desde el panel admin con feature_flags.themes)
const SUBATHON_THEMES = ['clasico', 'solo', 'neon', 'cyber', 'glass', 'arcade', 'fuego', 'wolf', 'oso'];
function subathonThemeAllowed(theme, streamer) {
  if (!SUBATHON_THEMES.includes(theme)) return false;
  const u = String(streamer?.twitch_username || '').toLowerCase();
  const flags = streamer?.feature_flags?.themes || [];
  if (theme === 'wolf') return ['lordlonelywolf', 'elosoking1'].includes(u) || flags.includes('wolf');
  if (theme === 'oso') return u === 'elosoking1' || flags.includes('oso');
  return true;
}

app.post('/api/subathon-config', requireAuth, async (req, res) => {
  try {
    const { subathon_config } = req.body;
    if (!isValidObject(subathon_config)) return res.status(400).json({ error: 'Inválido' });
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    if (streamer?.plan !== 'pro' && streamer?.plan !== 'admin') return res.status(403).json({ error: 'Función exclusiva de Pro' });
    if (subathon_config.theme !== undefined && !subathonThemeAllowed(subathon_config.theme, streamer)) return res.status(400).json({ error: 'Ese estilo no está disponible para tu canal' });
    const current = streamer?.subathon_config || {};
    // Solo actualizar los campos de configuración — nunca pisar running/target_end_time/remaining_seconds desde aquí
    const merged = { ...current, ...subathon_config };
    await sbUpdate('streamers', { subathon_config: merged }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/subathon/control', requireAuth, async (req, res) => {
  try {
    const { action, minutes } = req.body;
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    if (streamer?.plan !== 'pro' && streamer?.plan !== 'admin') return res.status(403).json({ error: 'Función exclusiva de Pro' });
    const cfg = streamer?.subathon_config || {};
    let updated = { ...cfg };

    if (action === 'start') {
      const startSeconds = Math.max(0, (parseFloat(minutes) || 0) * 60);
      updated = { ...cfg, running: true, target_end_time: new Date(Date.now() + startSeconds * 1000).toISOString(), remaining_seconds: 0, contributors: {} };
    } else if (action === 'pause') {
      if (cfg.running && cfg.target_end_time) {
        const secondsLeft = Math.max(0, Math.floor((new Date(cfg.target_end_time).getTime() - Date.now()) / 1000));
        updated = { ...cfg, running: false, remaining_seconds: secondsLeft };
      }
    } else if (action === 'resume') {
      const secondsLeft = cfg.remaining_seconds || 0;
      updated = { ...cfg, running: true, target_end_time: new Date(Date.now() + secondsLeft * 1000).toISOString() };
    } else if (action === 'adjust') {
      const deltaSeconds = (parseFloat(minutes) || 0) * 60;
      if (cfg.running && cfg.target_end_time) {
        const currentEnd = new Date(cfg.target_end_time).getTime();
        const newEnd = Math.max(Date.now(), currentEnd + deltaSeconds * 1000);
        updated = { ...cfg, target_end_time: new Date(newEnd).toISOString() };
      } else {
        updated = { ...cfg, remaining_seconds: Math.max(0, (cfg.remaining_seconds || 0) + deltaSeconds) };
      }
    } else if (action === 'stop') {
      updated = { ...cfg, running: false, remaining_seconds: 0, target_end_time: null };
    } else {
      return res.status(400).json({ error: 'Acción inválida' });
    }

    await sbUpdate('streamers', { subathon_config: updated }, { twitch_id: req.session.user.id });
    res.json({ success: true, subathon_config: updated });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Estado público — usado por el overlay y el panel del dashboard (polling, sin auth para que el overlay de OBS pueda leerlo)
app.get('/api/subathon/state/:username', async (req, res) => {
  try {
    const u = req.params.username.toLowerCase();
    const streamer = await ttlCache('subathon:' + u, 2000, () => sbSelect('streamers', { twitch_username: u }, 'subathon_config,twitch_username,feature_flags'));
    const cfg = streamer?.subathon_config || {};
    res.json({
      enabled: !!cfg.enabled,
      theme: subathonThemeAllowed(cfg.theme, streamer) ? cfg.theme : 'clasico',
      running: !!cfg.running,
      target_end_time: cfg.target_end_time || null,
      remaining_seconds: cfg.remaining_seconds || 0,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/overlay/subathon/:username', (req, res) => {
  res.sendFile(path.join(__dirname, 'subathon-overlay.html'));
});

app.get('/api/counters/state/:username', async (req, res) => {
  try {
    const name = (req.query.name || '').toLowerCase().trim();
    if (!name) return res.status(400).json({ error: 'Falta el nombre del contador' });
    const u = req.params.username.toLowerCase();
    const streamer = await ttlCache('counters:' + u, 2000, () => sbSelect('streamers', { twitch_username: u }, 'counters,twitch_username,feature_flags'));
    const counters = streamer?.counters || {};
    const theme = subathonThemeAllowed(String(req.query.theme || ''), streamer) ? String(req.query.theme) : 'clasico'; // mismos estilos que el subatón; los exclusivos se validan aquí
    if (counters[name] === undefined) return res.json({ exists: false, value: null, name, theme });
    res.json({ exists: true, value: counters[name], name, theme });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/overlay/counter/:username', (req, res) => {
  res.sendFile(path.join(__dirname, 'counter-overlay.html'));
});


// Operaciones atómicas sobre UN contador: lee los datos frescos de la BD y cambia solo esa clave
// (así el dashboard nunca pisa lo que el chat acaba de sumar)
const COUNTER_NAME_RE = /^[a-z0-9_]{1,20}$/;
const COUNTER_MAX = 999999999;
const _counterOpLocks = new Map();
function withCounterOpLock(key, fn) {
  const prev = _counterOpLocks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  _counterOpLocks.set(key, next);
  next.finally(() => { if (_counterOpLocks.get(key) === next) _counterOpLocks.delete(key); }).catch(() => {});
  return next;
}
app.get('/api/counters', requireAuth, async (req, res) => {
  try {
    const st = await sbSelect('streamers', { twitch_id: req.session.user.id }, 'counters');
    res.json({ counters: st?.counters || {} });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/counters/op', requireAuth, async (req, res) => {
  try {
    const { name, op } = req.body || {};
    const n = Number.isFinite(Number(req.body?.value)) ? Math.trunc(Number(req.body.value)) : 0;
    const key = String(name || '').toLowerCase();
    if (!COUNTER_NAME_RE.test(key)) return res.status(400).json({ error: 'Nombre inválido (solo letras, números y guion bajo, máx. 20)' });
    if (!['create', 'add', 'set', 'reset', 'delete'].includes(op)) return res.status(400).json({ error: 'Operación inválida' });
    const out = await withCounterOpLock('op:' + req.session.user.id, async () => {
      const st = await sbSelect('streamers', { twitch_id: req.session.user.id }, 'counters,twitch_username');
      if (!st) return { status: 404, body: { error: 'Streamer no encontrado' } };
      const counters = { ...(st.counters || {}) };
      if (op === 'create') {
        if (counters[key] !== undefined) return { status: 409, body: { error: 'Ese contador ya existe' } };
        if (Object.keys(counters).length >= 50) return { status: 400, body: { error: 'Máximo 50 contadores' } };
        counters[key] = 0;
      } else if (counters[key] === undefined) {
        return { status: 404, body: { error: 'Ese contador ya no existe (¿lo borraron desde el chat?)', counters } };
      } else if (op === 'delete') delete counters[key];
      else if (op === 'reset') counters[key] = 0;
      else if (op === 'add') counters[key] = Math.min(COUNTER_MAX, Math.max(0, (Number(counters[key]) || 0) + n));
      else if (op === 'set') counters[key] = Math.min(COUNTER_MAX, Math.max(0, n));
      await sbUpdate('streamers', { counters }, { twitch_id: req.session.user.id });
      _ttlCache.delete('counters:' + String(st.twitch_username || '').toLowerCase());
      return { status: 200, body: { success: true, counters } };
    });
    res.status(out.status).json(out.body);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/counters', requireAuth, async (req, res) => {
  try {
    const { counters } = req.body;
    if (!isValidObject(counters)) return res.status(400).json({ error: 'Inválido' });
    const entries = Object.entries(counters);
    if (entries.length > 50 || entries.some(([k, v]) => !COUNTER_NAME_RE.test(k) || !Number.isInteger(v) || v < 0 || v > COUNTER_MAX)) return res.status(400).json({ error: 'Contadores inválidos' });
    await sbUpdate('streamers', { counters }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/counters-permission', requireAuth, async (req, res) => {
  try {
    const { counters_permission } = req.body;
    const valid = ['everyone', 'sub', 'vip', 'mod'];
    if (!Array.isArray(counters_permission) || !counters_permission.every(p => valid.includes(p))) {
      return res.status(400).json({ error: 'Inválido' });
    }
    await sbUpdate('streamers', { counters_permission }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/system-commands', requireAuth, async (req, res) => {
  try {
    const { system_commands } = req.body;
    if (!isValidObject(system_commands)) return res.status(400).json({ error: 'Inválido' });
    await sbUpdate('streamers', { system_commands }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── APIs de Premios y Canjes ──
app.get('/api/redeem-requests', requireAuth, async (req, res) => {
  try {
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    res.json(streamer?.redeem_requests || []);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/redeem-requests/complete', requireAuth, async (req, res) => {
  try {
    const { id } = req.body;
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    const requests = (streamer?.redeem_requests || []).map(r => r.id === id ? { ...r, status: 'completed' } : r);
    await sbUpdate('streamers', { redeem_requests: requests }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/redeem-requests/delete', requireAuth, async (req, res) => {
  try {
    const { id } = req.body;
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    const requests = (streamer?.redeem_requests || []).filter(r => r.id !== id);
    await sbUpdate('streamers', { redeem_requests: requests }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/points-config', requireAuth, async (req, res) => {
  try {
    const { points_config } = req.body;
    if (!isValidObject(points_config)) return res.status(400).json({ error: 'Config inválida' });
    await sbUpdate('streamers', { points_config }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/points-ranking', requireAuth, async (req, res) => {
  try {
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    const points = streamer?.viewer_points || {};
    const ranking = Object.entries(points)
      .map(([username, xp]) => ({ username, xp }))
      .sort((a, b) => b.xp - a.xp);
    res.json(ranking);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// API — guardar credenciales de Spotify
app.post('/api/spotify/credentials', requireAuth, async (req, res) => {
  try {
    const { spotify_client_id, spotify_client_secret } = req.body;
    if (!spotify_client_id || !spotify_client_secret) return res.status(400).json({ error: 'Faltan credenciales' });
    await sbUpdate('streamers', { spotify_client_id, spotify_client_secret }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Spotify OAuth ──
app.get('/auth/spotify', requireAuth, async (req, res) => {
  try {
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    const clientId = streamer?.spotify_client_id;
    if (!clientId) return res.redirect('/dashboard?spotify=nocreds');
    const url = `https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(BASE_URL+'/auth/spotify/callback')}&scope=${encodeURIComponent(SPOTIFY_SCOPES)}`;
    res.redirect(url);
  } catch(err) { res.redirect('/dashboard?spotify=error'); }
});

app.get('/auth/spotify/callback', requireAuth, async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/dashboard?section=settings&spotify=error');
  try {
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    const clientId = streamer?.spotify_client_id;
    const clientSecret = streamer?.spotify_client_secret;
    if (!clientId || !clientSecret) return res.redirect('/dashboard?spotify=nocreds');
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: BASE_URL+'/auth/spotify/callback' }).toString()
    });
    const data = await tokenRes.json();
    if (!data.access_token) return res.redirect('/dashboard?spotify=error');
    await sbUpdate('streamers', { spotify_token: data.access_token, spotify_refresh: data.refresh_token }, { twitch_id: req.session.user.id });
    res.redirect('/dashboard?spotify=success');
  } catch(err) { res.redirect('/dashboard?spotify=error'); }
});

// Refresh Spotify token
async function refreshSpotifyToken(refreshToken, clientId, clientSecret) {
  if (!clientId || !clientSecret) return null;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString()
  });
  const data = await res.json();
  return data.access_token || null;
}

// API — canción actual
app.get('/api/spotify/current', requireAuth, async (req, res) => {
  try {
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    let token = streamer?.spotify_token;
    if (!token) return res.json({ connected: false });

    // Refrescar token si expiró
    let r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (r.status === 401 && streamer.spotify_refresh) {
      token = await refreshSpotifyToken(streamer.spotify_refresh, streamer.spotify_client_id, streamer.spotify_client_secret);
      if (token) {
        await sbUpdate('streamers', { spotify_token: token }, { twitch_id: req.session.user.id });
        r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', { headers: { 'Authorization': `Bearer ${token}` } });
      }
    }
    if (r.status === 204) return res.json({ connected: true, playing: false, queue: [] });
    const data = await r.json();

    // Obtener cola
    let queue = [];
    try {
      const qr = await fetch('https://api.spotify.com/v1/me/player/queue', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (qr.ok) {
        const qd = await qr.json();
        queue = (qd.queue || []).slice(0, 8).map(t => ({
          name: t.name,
          artist: t.artists?.[0]?.name || '',
          image: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || ''
        }));
      }
    } catch(e) {}

    res.json({
      connected: true,
      playing: true,
      track: data.item?.name,
      artist: data.item?.artists?.[0]?.name,
      album_art: data.item?.album?.images?.[0]?.url,
      progress_ms: data.progress_ms,
      duration_ms: data.item?.duration_ms,
      queue
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// API — listar recompensas de puntos del canal
app.get('/api/raffle/rewards', requireAuth, async (req, res) => {
  try {
    const data = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_id=eq.${req.session.user.id}&limit=1`, { headers: sbHeaders });
    const streamer = (await data.json())?.[0];
    const token = await getFreshTwitchToken(streamer);
    if (!token) return res.status(400).json({ error: 'Sin token de Twitch — reconecta tu cuenta' });
    const r = await fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${streamer.twitch_id}&only_manageable_rewards=false`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID }
    });
    if (!r.ok) {
      const err = await r.json();
      console.error('[rewards] Twitch error:', r.status, JSON.stringify(err));
      return res.status(400).json({ error: err.message || `Error Twitch ${r.status}`, details: err });
    }
    const rewards = await r.json();
    res.json({ rewards: rewards.data || [] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// API — config de Spotify
app.post('/api/spotify/config', requireAuth, async (req, res) => {
  try {
    const { spotify_config } = req.body;
    await sbUpdate('streamers', { spotify_config }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// API — desconectar Spotify
app.post('/api/spotify/disconnect', requireAuth, async (req, res) => {
  try {
    await sbUpdate('streamers', { spotify_token: null, spotify_refresh: null }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/youtube-videos/:channelId', async (req, res) => {
  try {
    const { channelId } = req.params;
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const response = await fetch(rssUrl);
    if (!response.ok) return res.json([]);
    const xml = await response.text();
    const videos = [];
    const entries = xml.split('<entry>').slice(1);
    for (const entry of entries.slice(0, 4)) {
      const videoId = entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1];
      const title = entry.match(/<title>(.*?)<\/title>/)?.[1]?.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
      const published = entry.match(/<published>(.*?)<\/published>/)?.[1];
      if (videoId && title) {
        videos.push({
          videoId, title,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          thumb: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
          date: published ? new Date(published).toLocaleDateString('es-DO',{day:'numeric',month:'short',year:'numeric'}) : ''
        });
      }
    }
    res.json(videos);
  } catch(err) { res.json([]); }
});

app.get('/overlay/sorteo/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    const url = `${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${username}&approved=eq.true&select=plan&limit=1`;
    const result = await fetch(url, { headers: sbHeaders });
    const data = await result.json();
    if (!data?.[0] || (data[0].plan !== 'pro' && data[0].plan !== 'admin')) return proOnlyPage(res);
    res.sendFile(path.join(__dirname, 'raffle-overlay.html'));
  } catch(err) { res.status(500).send('Error'); }
});

app.get('/api/raffle/overlay/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    const streamer = await ttlCache('raffle:' + username, 1000, async () => {
      const url = `${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${username}&approved=eq.true&select=raffle_active,raffle_settings&limit=1`;
      const result = await fetch(url, { headers: sbHeaders });
      const data = await result.json();
      return data?.[0] || null;
    });
    if (!streamer) return res.status(404).json({ error: 'Canal no encontrado' });
    const raffle = streamer.raffle_active || {};
    const join_cmd = streamer.raffle_settings?.join_cmd || '!entrar';
    res.json({ active: !!raffle.active, prize: raffle.prize || '', participants: raffle.participants || [], winner: raffle.winner || null, join_cmd, entry_mode: streamer.raffle_settings?.entry_mode || null, reward_name: streamer.raffle_settings?.reward_name || '', overlay_opacity: streamer.raffle_settings?.overlay_opacity ?? 100, bg_opacity: streamer.raffle_settings?.bg_opacity ?? 75, spin_style: streamer.raffle_settings?.spin_style || 'ruleta', card_size: streamer.raffle_settings?.card_size || 'medium' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/raffle/add-participant', requireAuth, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username?.trim()) return res.status(400).json({ error: 'Nombre inválido' });
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    if (!streamer) return res.status(404).json({ error: 'Streamer no encontrado' });
    const raffle = streamer.raffle_active || {};
    if (!raffle.active) return res.status(400).json({ error: 'No hay sorteo activo' });
    const participants = raffle.participants || [];
    participants.push(username.trim());
    await sbUpdate('streamers', { raffle_active: { ...raffle, participants } }, { twitch_id: req.session.user.id });
    res.json({ ok: true, count: participants.length });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/raffle/settings', requireAuth, async (req, res) => {
  try {
    const { raffle_settings } = req.body;
    await sbUpdate('streamers', { raffle_settings }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/raffle/status', requireAuth, async (req, res) => {
  try {
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    const raffle = streamer?.raffle_active || {};
    res.json({ active: !!raffle.active, prize: raffle.prize || '', participants: raffle.participants || [] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/raffle/start', requireAuth, async (req, res) => {
  try {
    const { prize } = req.body;
    const raffle_active = { active: true, prize: prize || 'Sorpresa', participants: [], started_at: new Date().toISOString() };
    await sbUpdate('streamers', { raffle_active }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/raffle/end', requireAuth, async (req, res) => {
  try {
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    const raffle = streamer?.raffle_active || {};
    const participants = raffle.participants || [];
    if (!participants.length) return res.json({ success: true, winner: null });
    const winner = participants[Math.floor(Math.random() * participants.length)];
    await sbUpdate('streamers', { raffle_active: { active: false, prize: raffle.prize, winner, participants: [], ended_at: new Date().toISOString() } }, { twitch_id: req.session.user.id });

    // Notificar al bot para que anuncie el ganador en el chat
    const botUrl = `${process.env.BOT_URL || 'http://localhost:' + (process.env.BOT_PORT || 3001)}/event`;
    fetch(botUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: process.env.BOT_SECRET || 'muffetbot-internal-2026',
        type: 'raffle.winner',
        event: { broadcaster_user_login: streamer.twitch_username, winner, prize: raffle.prize }
      })
    }).catch(() => {});

    res.json({ success: true, winner, prize: raffle.prize });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/raffle/cancel', requireAuth, async (req, res) => {
  try {
    await sbUpdate('streamers', { raffle_active: { active: false } }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/raffle/remove', requireAuth, async (req, res) => {
  try {
    const { username } = req.body;
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    const raffle = streamer?.raffle_active || {};
    const participants = (raffle.participants || []).filter(p => p !== username);
    await sbUpdate('streamers', { raffle_active: { ...raffle, participants } }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/socials', requireAuth, async (req, res) => {
  try {
    const { social_links, youtube_channel_id, public_name } = req.body;
    if (!isValidObject(social_links)) return res.status(400).json({ error: 'Links inválidos' });
    const update = { social_links };
    if (youtube_channel_id !== undefined) update.youtube_channel_id = youtube_channel_id || null;
    if (public_name !== undefined) update.public_name = public_name || null;
    await sbUpdate('streamers', update, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar' });
  }
});

app.post('/api/ai-toggle', requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Valor inválido' });
    await sbUpdate('streamers', { ai_enabled: enabled }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/ai-toggle:', err.message);
    res.status(500).json({ error: 'Error al guardar' });
  }
});

app.post('/api/moderation', requireAuth, async (req, res) => {
  try {
    const { mod_enabled, banned_words, warn_message } = req.body;
    if (typeof mod_enabled !== 'boolean') return res.status(400).json({ error: 'mod_enabled inválido' });
    if (!isValidArray(banned_words)) return res.status(400).json({ error: 'banned_words inválido' });
    if (!isValidString(warn_message, 500)) return res.status(400).json({ error: 'warn_message inválido' });
    await sbUpdate('streamers', { mod_enabled, banned_words, warn_message }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/moderation:', err.message);
    res.status(500).json({ error: 'Error al guardar' });
  }
});

// ── CLIPS PARA SHOUTOUT OVERLAY ──
app.get('/api/shoutout-clips/:username', async (req, res) => {
  const target = req.params.username.toLowerCase();
  try {
    const tokenRes = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`, { method:'POST' });
    const tokenData = await tokenRes.json();
    const appToken = tokenData.access_token;
    if (!appToken) return res.status(500).json({ error: 'Sin token' });

    const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${target}`,
      { headers: { 'Authorization': `Bearer ${appToken}`, 'Client-Id': process.env.TWITCH_CLIENT_ID } });
    const userData = await userRes.json();
    const user = userData?.data?.[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Obtener config del canal que hace el shoutout (no del target)
    const configChannel = (req.query.channel || target).toLowerCase();
    const configRes = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${configChannel}&select=shoutout_config&limit=1`, { headers: sbHeaders });
    const configData = await configRes.json();
    const sConfig = configData?.[0]?.shoutout_config || {};
    const selectionMode = sConfig.selection_mode || 'random';
    const timeFrame = sConfig.time_frame || 'all';
    const minDuration = sConfig.min_duration || 0;
    const maxDuration = sConfig.max_duration || 60;
    const quality = sConfig.quality || '1080';

    // Parámetros de búsqueda según marco de tiempo
    let clipsUrl = `https://api.twitch.tv/helix/clips?broadcaster_id=${user.id}&first=50`;
    if (timeFrame === 'week') {
      const d = new Date(); d.setDate(d.getDate() - 7);
      clipsUrl += `&started_at=${d.toISOString()}`;
    } else if (timeFrame === 'month') {
      const d = new Date(); d.setMonth(d.getMonth() - 1);
      clipsUrl += `&started_at=${d.toISOString()}`;
    } else if (timeFrame === 'year') {
      const d = new Date(); d.setFullYear(d.getFullYear() - 1);
      clipsUrl += `&started_at=${d.toISOString()}`;
    }
    // Más popular = ordenar por views (API ya los devuelve así por defecto)

    const clipsRes = await fetch(clipsUrl,
      { headers: { 'Authorization': `Bearer ${appToken}`, 'Client-Id': process.env.TWITCH_CLIENT_ID } });
    const clipsData = await clipsRes.json();
    let clips = clipsData?.data || [];

    // Filtrar por duración mínima y máxima
    if (minDuration > 0) clips = clips.filter(c => c.duration >= minDuration);
    clips = clips.filter(c => c.duration <= maxDuration);

    if (!clips.length) return res.json({ user, clip: null, mp4Url: null, fallback: sConfig.fallback_profile || false });

    // Selección: aleatorio o más popular (ya viene ordenado por views)
    const clip = selectionMode === 'random'
      ? clips[Math.floor(Math.random() * clips.length)]
      : clips[0];

    // Obtener URL autenticada del clip via GQL (método yt-dlp)
    let mp4Url = null;
    try {
      const streamerRes = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${target}&select=access_token&limit=1`, { headers: sbHeaders });
      const streamerData = await streamerRes.json();
      const userToken = streamerData?.[0]?.access_token;

      const gqlHeaders = {
        'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
        'Content-Type': 'application/json'
      };
      // Sin autenticación primero — el token del usuario puede estar expirado

      const gqlRes = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: gqlHeaders,
        body: JSON.stringify([{
          query: `{
            clip(slug: "${clip.id}") {
              videoQualities { quality frameRate sourceURL }
              playbackAccessToken(params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) {
                signature value
              }
            }
          }`
        }])
      });
      const gqlData = await gqlRes.json();
      const clipData = gqlData?.[0]?.data?.clip;
      const token = clipData?.playbackAccessToken;
      const qualities = clipData?.videoQualities || [];

      if (token && qualities.length) {
        // Construir URL autenticada: sourceURL + sig + token (método yt-dlp)
        const best = qualities.find(q => q.quality === quality) || qualities.find(q => q.quality === '720') || qualities[0];
        if (best?.sourceURL) {
          mp4Url = `${best.sourceURL}?sig=${token.signature}&token=${encodeURIComponent(token.value)}`;
        }
      }
    } catch(e) { console.error('[GQL]', e.message); }

    res.json({ user, clip, mp4Url, config: sConfig, overlay_opacity: sConfig.overlay_opacity ?? 100 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PROXY MP4 CLIP ──
app.get('/api/clip-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url || !url.includes('cloudfront.net')) return res.status(400).end();
  try {
    const range = req.headers.range;
    const headers = {
      'Referer': 'https://clips.twitch.tv/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'https://clips.twitch.tv'
    };
    if (range) headers['Range'] = range;
    const videoRes = await fetch(url, { headers });
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    if (videoRes.headers.get('content-length')) res.setHeader('Content-Length', videoRes.headers.get('content-length'));
    if (videoRes.headers.get('content-range')) res.setHeader('Content-Range', videoRes.headers.get('content-range'));
    res.status(videoRes.status);
    videoRes.body.pipe(res);
  } catch(e) { res.status(500).end(); }
});

// ── CACHE DE CLIPS EN MEMORIA ──
const clipCache = new Map(); // username -> { buffer, contentType, expires }

app.post('/api/cache-clip', async (req, res) => {
  const { username, url } = req.body;
  if (!username || !url || !url.includes('cloudfront.net')) return res.status(400).json({ error: 'Inválido' });
  try {
    const videoRes = await fetch(url, {
      headers: { 'Referer': 'https://clips.twitch.tv/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!videoRes.ok) return res.status(videoRes.status).json({ error: 'No se pudo descargar' });
    const buffer = Buffer.from(await videoRes.arrayBuffer());
    clipCache.set(username, { buffer, expires: Date.now() + 120000 }); // expira en 2 min
    console.log(`[Clip cache] ${username} — ${Math.round(buffer.length/1024)}KB`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clip-cached/:username', (req, res) => {
  const cached = clipCache.get(req.params.username);
  if (!cached || Date.now() > cached.expires) return res.status(404).end();
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', cached.buffer.length);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(cached.buffer);
});

// ── PROXY VIDEO CLIP ──
app.get('/api/clip-video', async (req, res) => {
  const { url } = req.query;
  if (!url || !url.includes('cloudfront.net')) return res.status(400).end();
  try {
    const videoRes = await fetch(url, {
      headers: { 'Referer': 'https://clips.twitch.tv/', 'User-Agent': 'Mozilla/5.0' }
    });
    if (!videoRes.ok) return res.status(videoRes.status).end();
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const range = req.headers.range;
    if (range) res.setHeader('Content-Range', videoRes.headers.get('content-range') || '');
    videoRes.body.pipe(res);
  } catch(e) { res.status(500).end(); }
});

// ── SHOUTOUT CONFIG ──
app.post('/api/shoutout-config', requireAuth, async (req, res) => {
  const { shoutout_config } = req.body;
  if (!isValidObject(shoutout_config)) return res.status(400).json({ error: 'Inválido' });
  await sbUpdate('streamers', { shoutout_config }, { twitch_id: req.session.user.id });
  res.json({ ok: true });
});

// ── SHOUTOUT CONFIG PÚBLICA (para el overlay) ──
app.get('/api/shoutout-config-public/:username', async (req, res) => {
  const username = req.params.username.toLowerCase();
  try {
    const data = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${username}&select=shoutout_config&limit=1`, { headers: sbHeaders });
    const rows = await data.json();
    res.json({ config: rows?.[0]?.shoutout_config || {} });
  } catch(e) { res.json({ config: {} }); }
});

// ── FOLLOWERS PARA OVERLAY ──
// Token de app de Twitch: se reutiliza hasta que esté por vencer (antes se pedía uno nuevo en cada consulta)
let _twitchAppTokenCache = { token: null, exp: 0 };
async function getCachedTwitchAppToken() {
  if (_twitchAppTokenCache.token && Date.now() < _twitchAppTokenCache.exp) return _twitchAppTokenCache.token;
  const tokenRes = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`, { method: 'POST' });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return null;
  _twitchAppTokenCache = { token: tokenData.access_token, exp: Date.now() + Math.max(60, (tokenData.expires_in || 3600) - 300) * 1000 };
  return _twitchAppTokenCache.token;
}
app.get('/api/shoutout-followers/:username', async (req, res) => {
  try {
    const login = String(req.params.username || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30);
    if (!login) return res.json({ followers: null });
    const followers = await ttlCache('followers:' + login, 60000, async () => {
      const appToken = await getCachedTwitchAppToken();
      if (!appToken) return null;
      const h = { 'Authorization': `Bearer ${appToken}`, 'Client-Id': process.env.TWITCH_CLIENT_ID };
      const userData = await (await fetch(`https://api.twitch.tv/helix/users?login=${login}`, { headers: h })).json();
      const userId = userData?.data?.[0]?.id;
      if (!userId) return null;
      const followData = await (await fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${userId}`, { headers: h })).json();
      return followData?.total ?? null;
    });
    res.json({ followers });
  } catch(e) { res.json({ followers: null }); }
});

// ── SHOUTOUT OVERLAY ──
// ── YouTube Player Overlay ──
// Clave del overlay: firma del usuario. Va en el link de OBS (?key=...) y protege los endpoints que modifican la cola.
// Los links viejos (sin key) siguen funcionando mientras YT_OVERLAY_ENFORCE no sea "1".
const YT_OVERLAY_SECRET = process.env.OVERLAY_SECRET || SESSION_SECRET || EVENTSUB_SECRET;
function ytOverlayKey(username) {
  return crypto.createHmac('sha256', YT_OVERLAY_SECRET).update('yt-overlay:' + String(username || '').toLowerCase()).digest('hex').slice(0, 24);
}
function ytOverlayKeyOk(channel, key) {
  if (key) {
    const a = Buffer.from(String(key)), b = Buffer.from(ytOverlayKey(channel));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return process.env.YT_OVERLAY_ENFORCE !== '1';
}

// Escritura segura de youtube_config (compare-and-swap con el campo "rev") — evita que dos cambios simultáneos se pisen
async function ytMutate(channel, mutator, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${encodeURIComponent(channel)}&select=youtube_config&limit=1`, { headers: sbHeaders });
    const d = await r.json();
    if (!Array.isArray(d) || !d.length) return { ok: false, error: 'nochannel' };
    const cur = d[0].youtube_config || {};
    const draft = JSON.parse(JSON.stringify(cur));
    const out = (await mutator(draft)) || {};
    if (out.abort) return { ok: false, aborted: true, ...out };
    draft.rev = (Number(cur.rev) || 0) + 1;
    const filter = cur.rev == null ? 'youtube_config->>rev=is.null' : `youtube_config->>rev=eq.${encodeURIComponent(cur.rev)}`;
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${encodeURIComponent(channel)}&${filter}`, {
      method: 'PATCH', headers: { ...sbHeaders, 'Prefer': 'return=representation' },
      body: JSON.stringify({ youtube_config: draft })
    });
    const pd = await pr.json().catch(() => null);
    if (Array.isArray(pd) && pd.length) { delete ytCfgCache[channel]; return { ok: true, config: draft, ...out }; }
    if (!pr.ok) throw new Error('supabase ' + pr.status);
    await new Promise(res => setTimeout(res, 40 + Math.random() * 120));
  }
  return { ok: false, error: 'conflict' };
}

// Quita el primer elemento de la cola (o el indicado), lo manda al historial y libera el límite del usuario
function ytRemoveFromQueue(cfg, index) {
  const queue = Array.isArray(cfg.queue) ? cfg.queue : [];
  if (index < 0 || index >= queue.length) return null;
  const [removed] = queue.splice(index, 1);
  cfg.queue = queue;
  const limits = cfg.song_limits || {};
  const who = removed.requestedBy;
  if (who && Array.isArray(limits[who])) {
    const i = limits[who].findIndex(s => s.uri === removed.videoId);
    if (i >= 0) limits[who].splice(i, 1);
    if (limits[who].length === 0) delete limits[who];
  }
  cfg.song_limits = limits;
  return removed;
}

// Campos que el dashboard SÍ puede cambiar desde "Guardar" (nunca la cola, el historial ni los límites)
const YT_SETTINGS_KEYS = ['enabled','max_per_user','max_duration_min','volume','card_width','card_height','card_position','accent_color','show_title','allowed','playlist_url','blacklist','playlist_shuffle','playlist_loop','display_mode','theme','layout','cover'];
const YT_THEMES = ['classic','glass','pill','macos','minimal','line','synthwave','neoncity','cyber','glitch','retro','muffet','osoking','undertale','wolf','oso'];
function ytSanitizeSettings(src) {
  const out = {};
  if (!isValidObject(src)) return out;
  for (const k of YT_SETTINGS_KEYS) {
    if (!(k in src)) continue;
    const v = src[k];
    switch (k) {
      case 'enabled': case 'show_title': case 'playlist_shuffle': case 'playlist_loop': out[k] = !!v; break;
      case 'display_mode': out[k] = v === 'card' ? 'card' : 'video'; break;
      case 'theme': out[k] = YT_THEMES.includes(v) ? v : 'classic'; break;
      case 'layout': out[k] = v === 'vertical' ? 'vertical' : 'horizontal'; break;
      case 'cover': out[k] = v === 'disc' ? 'disc' : 'square'; break;
      case 'max_per_user': out[k] = Math.max(1, Math.min(20, parseInt(v) || 3)); break;
      case 'max_duration_min': out[k] = Math.max(1, Math.min(180, parseInt(v) || 10)); break;
      case 'volume': out[k] = Math.max(0, Math.min(100, parseInt(v))); if (isNaN(out[k])) delete out[k]; break;
      case 'card_width': out[k] = Math.max(200, Math.min(1920, parseInt(v) || 480)); break;
      case 'card_height': out[k] = Math.max(120, Math.min(1080, parseInt(v) || 300)); break;
      case 'card_position': if (isValidString(v, 30)) out[k] = v; break;
      case 'accent_color': if (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) out[k] = v; break;
      case 'allowed': if (isValidArray(v)) out[k] = v.filter(x => ['everyone','sub','vip','mod'].includes(x)).slice(0, 4); break;
      case 'playlist_url': if (v === '' || v === null) out[k] = ''; else if (isValidString(v, 300) && !/[?&]list=(RDMM|LM|WL)/.test(v)) out[k] = v.trim(); break; // los mixes (RD), "me gusta" (LM) y "ver más tarde" (WL) no se pueden embeber
      case 'blacklist': if (isValidArray(v)) out[k] = v.filter(x => isValidString(x, 200) && x.trim()).map(x => x.trim()).slice(0, 200); break;
    }
  }
  return out;
}

// ── Playlist base leída desde el servidor (solo trae lo que está en la playlist; el overlay la reproduce video por video) ──
const ytPlaylistCache = {};  // listId -> { ts, items, total, skipped }
const ytPlaylistInfo = {};   // canal -> { ts, ok, error, total, skipped } (lo muestra el dashboard)
const YT_PLAYLIST_TTL = 15 * 60 * 1000;
function ytIsoSeconds(iso) {
  const m = String(iso || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return m ? (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0) : 0;
}
async function ytFetchPlaylist(listId, apiKey) {
  const base = 'https://www.googleapis.com/youtube/v3';
  const ids = []; let pageToken = '', pages = 0, total = 0;
  do {
    const r = await fetch(`${base}/playlistItems?part=snippet,contentDetails,status&maxResults=50&playlistId=${encodeURIComponent(listId)}${pageToken ? '&pageToken=' + pageToken : ''}&key=${apiKey}`);
    const d = await r.json();
    if (d.error) return { error: d.error.errors?.[0]?.reason || d.error.status || 'api' };
    for (const it of (d.items || [])) {
      total++;
      const vid = it.contentDetails?.videoId;
      const t = it.snippet?.title;
      if (!vid || t === 'Private video' || t === 'Deleted video' || it.status?.privacyStatus === 'private') continue;
      ids.push(vid);
    }
    pageToken = d.nextPageToken || ''; pages++;
  } while (pageToken && pages < 6);
  const items = await ytVideoDetails(ids, apiKey);
  if (items.error) return items;
  return { items, total, skipped: total - items.length };
}
// Detalles de una lista de videos (solo los reproducibles en un overlay), en el orden recibido
async function ytVideoDetails(ids, apiKey) {
  const base = 'https://www.googleapis.com/youtube/v3';
  const items = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await fetch(`${base}/videos?part=snippet,contentDetails,status&id=${ids.slice(i, i + 50).join(',')}&key=${apiKey}`);
    const d = await r.json();
    if (d.error) return { error: d.error.errors?.[0]?.reason || d.error.status || 'api' };
    for (const v of (d.items || [])) {
      const sec = ytIsoSeconds(v.contentDetails?.duration);
      const live = v.snippet?.liveBroadcastContent;
      if (v.status?.embeddable === false) continue;
      if (v.status?.privacyStatus && !['public', 'unlisted'].includes(v.status.privacyStatus)) continue;
      if ((live && live !== 'none') || sec === 0) continue;
      items.push({ videoId: v.id, title: v.snippet?.title || '', channelTitle: v.snippet?.channelTitle || '', durationSec: sec });
    }
  }
  const pos = {}; ids.forEach((id, i) => pos[id] = i);
  items.sort((a, b) => pos[a.videoId] - pos[b.videoId]);
  return items;
}
app.get('/api/youtube/playlist', async (req, res) => {
  const channel = String(req.query.channel || '').toLowerCase();
  if (!channel) return res.json({ ok: false, error: 'canal' });
  const note = (o) => { ytPlaylistInfo[channel] = { ts: Date.now(), ...o }; return res.json(o); };
  try {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) return note({ ok: false, error: 'nokey' });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${encodeURIComponent(channel)}&select=youtube_config&limit=1`, { headers: sbHeaders });
    const d = await r.json();
    const ycfg = d?.[0]?.youtube_config || {};
    const url = ycfg.playlist_url || '';
    const m = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
    if (!m) return note({ ok: false, error: 'sinplaylist' });
    const listId = m[1];
    if (/^(RDMM|LM|WL)/.test(listId)) return note({ ok: false, error: 'mix' });
    if (/^RD/.test(listId)) {
      // Mix de una canción: si el streamer lo "fijó" desde su navegador (con su sesión), se reproduce esa lista exacta; si no, lo arma YouTube
      const snap = ycfg.mix_snapshot;
      if (!(snap && snap.listId === listId && Array.isArray(snap.ids) && snap.ids.length)) return note({ ok: true, mix: true, listId });
      const key = 'snap:' + listId + ':' + snap.ts;
      let cs = ytPlaylistCache[key];
      if (!cs) {
        const items = await ytVideoDetails(snap.ids, apiKey);
        if (items.error) return note({ ok: false, error: items.error });
        cs = ytPlaylistCache[key] = { ts: Date.now(), items, total: snap.ids.length, skipped: snap.ids.length - items.length };
      }
      if (!cs.items.length) return note({ ok: false, error: 'vacia', total: cs.total, skipped: cs.skipped });
      return note({ ok: true, listId, items: cs.items, total: cs.total, skipped: cs.skipped, fixed: true });
    }
    let c = ytPlaylistCache[listId];
    if (!c || Date.now() - c.ts > YT_PLAYLIST_TTL) {
      const f = await ytFetchPlaylist(listId, apiKey);
      if (f.error) return note({ ok: false, error: f.error });
      c = ytPlaylistCache[listId] = { ts: Date.now(), ...f };
      const keys = Object.keys(ytPlaylistCache);
      if (keys.length > 50) { keys.sort((x, y) => ytPlaylistCache[x].ts - ytPlaylistCache[y].ts).slice(0, keys.length - 50).forEach(k => delete ytPlaylistCache[k]); }
    }
    if (!c.items.length) return note({ ok: false, error: 'vacia', total: c.total, skipped: c.skipped });
    note({ ok: true, listId, items: c.items, total: c.total, skipped: c.skipped });
  } catch (e) { note({ ok: false, error: 'red' }); }
});

// Lectura de la config con caché corto (1.5 s): el overlay y el dashboard la piden cada pocos segundos y así no se golpea Supabase por cada petición
const ytCfgCache = {}; // canal -> { ts, cfg }
async function ytReadConfig(channel) {
  const c = ytCfgCache[channel];
  if (c && Date.now() - c.ts < 1500) return c.cfg;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${encodeURIComponent(channel)}&select=youtube_config&limit=1`, { headers: sbHeaders });
  const d = await r.json();
  const cfg = (Array.isArray(d) && d[0]?.youtube_config) || {};
  ytCfgCache[channel] = { ts: Date.now(), cfg };
  return cfg;
}

// Estado en vivo del reproductor (lo manda el overlay cada pocos segundos; vive en memoria)
const ytLiveStatus = {}; // { canal: { ...estado, ts } }
setInterval(() => { const lim = Date.now() - 10 * 60 * 1000; for (const k of Object.keys(ytLiveStatus)) if (ytLiveStatus[k].ts < lim) delete ytLiveStatus[k]; for (const k of Object.keys(ytCfgCache)) if (ytCfgCache[k].ts < lim) delete ytCfgCache[k]; }, 10 * 60 * 1000).unref();

app.get('/overlay/youtube/:username', (req, res) => {
  res.sendFile(path.join(__dirname, 'youtube-overlay.html'));
});

app.get('/api/youtube/config', async (req, res) => {
  const channel = req.query.channel?.toLowerCase();
  if (!channel) return res.json({ config: {} });
  try { res.json({ config: await ytReadConfig(channel) }); } catch(e) { res.json({ config: {} }); }
});

app.get('/api/youtube/queue', async (req, res) => {
  const channel = req.query.channel?.toLowerCase();
  if (!channel) return res.json({ queue: [], config: {} });
  try {
    const cfg = await ytReadConfig(channel);
    // ?lite=1 (overlay): sin historial, límites ni lista negra, que el overlay no usa
    if (req.query.lite === '1') {
      const { history, song_limits, blacklist, mix_snapshot, ...lite } = cfg;
      lite.mix_ts = mix_snapshot?.ts || 0; // el overlay solo necesita saber si el mix fijado cambió
      return res.json({ queue: cfg.queue || [], config: lite });
    }
    res.json({ queue: cfg.queue || [], config: cfg });
  } catch(e) { res.json({ queue: [], config: {} }); }
});

// El overlay avisa que terminó (o se saltó) la canción
app.post('/api/youtube/queue/next', async (req, res) => {
  const channel = String(req.body?.channel || '').toLowerCase();
  const { videoId } = req.body || {};
  if (!channel) return res.json({ ok: false });
  if (!ytOverlayKeyOk(channel, req.body?.key || req.query.key)) return res.status(403).json({ ok: false, error: 'key' });
  try {
    const r = await ytMutate(channel, (cfg) => {
      const queue = cfg.queue || [];
      if (!queue.length || queue[0].videoId !== videoId) return { abort: true, reason: 'nohead' };
      const removed = ytRemoveFromQueue(cfg, 0);
      const history = Array.isArray(cfg.history) ? cfg.history : [];
      history.unshift({ ...removed, playedAt: new Date().toISOString() });
      cfg.history = history.slice(0, 30);
      return { remaining: (cfg.queue || []).length };
    });
    // Si ya no era la primera de la cola no es un error: otro proceso ya la quitó
    res.json({ ok: r.ok || r.reason === 'nohead', remaining: r.remaining ?? null });
  } catch(e) { res.json({ ok: false }); }
});

// Limpiar flag force_next
app.post('/api/youtube/queue/clearforce', async (req, res) => {
  const channel = String(req.query.channel || req.body?.channel || '').toLowerCase();
  if (!channel) return res.json({ ok: false });
  if (!ytOverlayKeyOk(channel, req.query.key || req.body?.key)) return res.status(403).json({ ok: false, error: 'key' });
  try {
    const r = await ytMutate(channel, (cfg) => { if (!cfg.force_next) return { abort: true }; delete cfg.force_next; });
    res.json({ ok: r.ok || !!r.aborted });
  } catch(e) { res.json({ ok: false }); }
});

// El overlay manda su estado real (qué suena, tiempo, pausa) para mostrarlo en el dashboard
app.post('/api/youtube/status', (req, res) => {
  const channel = String(req.body?.channel || '').toLowerCase();
  if (!channel) return res.json({ ok: false });
  if (!ytOverlayKeyOk(channel, req.body?.key || req.query.key)) return res.status(403).json({ ok: false });
  const b = req.body || {};
  ytLiveStatus[channel] = {
    ts: Date.now(),
    state: ['playing','paused','buffering','idle'].includes(b.state) ? b.state : 'idle',
    source: b.source === 'playlist' ? 'playlist' : (b.source === 'viewer' ? 'viewer' : null),
    videoId: isValidString(b.videoId, 20) ? b.videoId : null,
    title: isValidString(b.title, 300) ? b.title : null,
    author: isValidString(b.author, 200) ? b.author : null,
    current: Math.max(0, Number(b.current) || 0),
    duration: Math.max(0, Number(b.duration) || 0),
    volume: Math.max(0, Math.min(100, Number(b.volume) || 0)),
  };
  res.json({ ok: true });
});

app.get('/api/youtube/status', (req, res) => {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: 'No autorizado' });
  const st = ytLiveStatus[username.toLowerCase()];
  const online = !!st && Date.now() - st.ts < 12000;
  const pl = ytPlaylistInfo[username.toLowerCase()] || null;
  res.json({ online, status: online ? st : null, lastSeen: st?.ts || null, playlist: pl ? { ok: pl.ok, mix: !!pl.mix, fixed: !!pl.fixed, error: pl.error || null, total: pl.total ?? null, skipped: pl.skipped ?? null } : null });
});

// Link del overlay con su clave (para copiar a OBS)
app.get('/api/youtube/overlay-url', (req, res) => {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: 'No autorizado' });
  const u = username.toLowerCase();
  res.json({ url: `${BASE_URL}/overlay/youtube/${u}?channel=${u}&key=${ytOverlayKey(u)}`, enforced: process.env.YT_OVERLAY_ENFORCE === '1' });
});

// Control de reproducción: pausar/reanudar/saltar/volumen
app.post('/api/youtube/control', async (req, res) => {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: 'No autorizado' });
  const { action, value } = req.body || {};
  if (!['pause','play','skip','volume'].includes(action)) return res.json({ ok: false, error: 'accion' });
  try {
    const r = await ytMutate(username.toLowerCase(), (cfg) => {
      if (action === 'volume') {
        const v = parseInt(value);
        cfg.volume = Math.max(0, Math.min(100, isNaN(v) ? 0 : v));
        // OJO: el volumen NO toca player_command_ts; si no, el overlay repetiría el último comando (ej. "saltar") y el video desaparece
      } else {
        cfg.player_command = action;
        cfg.player_command_ts = Date.now();
      }
    });
    res.json({ ok: r.ok });
  } catch(e) { res.json({ ok: false }); }
});

// ── Spotify desde el dock: llamadas a la API del streamer (refresca el token si caducó) ──
async function spotifyApi(username, method, urlPath, body) {
  const st = await sbSelect('streamers', { twitch_username: username }, 'spotify_token,spotify_refresh,spotify_client_id,spotify_client_secret');
  if (!st?.spotify_token) return { notConnected: true };
  const call = (tok) => fetch('https://api.spotify.com/v1' + urlPath, { method, headers: body ? { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' } : { 'Authorization': `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined });
  let r = await call(st.spotify_token);
  if (r.status === 401 && st.spotify_refresh) {
    const tok = await refreshSpotifyToken(st.spotify_refresh, st.spotify_client_id, st.spotify_client_secret);
    if (tok) { await sbUpdate('streamers', { spotify_token: tok }, { twitch_username: username }); r = await call(tok); }
  }
  return { r };
}
function spotifyConnected(channel) { // ¿tiene Spotify conectado? (cacheado 30 s)
  return ttlCache('spotifyconn:' + channel, 30000, async () => {
    const st = await sbSelect('streamers', { twitch_username: channel }, 'spotify_token');
    return !!st?.spotify_token;
  });
}
function spotifyDockState(channel) { // lo que suena en Spotify (cacheado 2.5 s; varios docks comparten la consulta)
  return ttlCache('spotifydock:' + channel, 2500, async () => {
    const x = await spotifyApi(channel, 'GET', '/me/player');
    if (x.notConnected) return { connected: false };
    const r = x.r;
    if (r.status === 204) return { connected: true, active: false };
    if (r.status === 401 || r.status === 403) return { connected: true, error: 'reconnect' };
    if (!r.ok) return { connected: true, error: 'fail' };
    const d = await r.json().catch(() => null);
    if (!d) return { connected: true, active: false };
    const it = d.item;
    return {
      connected: true, active: !!d.device, playing: !!d.is_playing,
      track: it?.name || null, artist: it?.artists?.map(a => a.name).join(', ') || null,
      image: it?.album?.images?.[1]?.url || it?.album?.images?.[0]?.url || '',
      progress_ms: d.progress_ms || 0, duration_ms: it?.duration_ms || 0, ts: Date.now(),
      repeat: d.repeat_state || 'off', volume: d.device?.volume_percent ?? null, volume_ok: d.device?.supports_volume !== false, device: d.device?.name || null
    };
  });
}
const SPOTIFY_DOCK_ACTIONS = { spotify_pause: ['PUT', '/me/player/pause'], spotify_play: ['PUT', '/me/player/play'], spotify_next: ['POST', '/me/player/next'], spotify_prev: ['POST', '/me/player/previous'] };
// Tras un rato en pausa Spotify marca el dispositivo como inactivo (404): lo despertamos transfiriendo la reproducción al último dispositivo visible
async function spotifyWake(channel) {
  const x = await spotifyApi(channel, 'GET', '/me/player/devices');
  if (x.notConnected || !x.r?.ok) return false;
  const j = await x.r.json().catch(() => null);
  const devs = (j?.devices || []).filter(d => d.id && !d.is_restricted);
  const dev = devs.find(d => d.is_active) || devs.find(d => d.type === 'Computer') || devs[0];
  if (!dev) return false;
  const t = await spotifyApi(channel, 'PUT', '/me/player', { device_ids: [dev.id], play: true });
  return !!t.r && (t.r.ok || t.r.status === 204);
}
async function spotifyDockControl(channel, action, value) {
  let m = SPOTIFY_DOCK_ACTIONS[action];
  if (action === 'spotify_restart') m = ['PUT', '/me/player/seek?position_ms=0'];
  if (action === 'spotify_volume') {
    const v = parseInt(value);
    m = ['PUT', `/me/player/volume?volume_percent=${Math.max(0, Math.min(100, isNaN(v) ? 0 : v))}`];
  }
  if (!m) return { ok: false, error: 'accion' };
  const x = await spotifyApi(channel, m[0], m[1]);
  if (x.notConnected) return { ok: false, error: 'notconnected' };
  let r = x.r;
  if (r.status === 404 && (action === 'spotify_play' || action === 'spotify_next' || action === 'spotify_prev')) {
    if (await spotifyWake(channel)) { _ttlCache.delete('spotifydock:' + channel); return { ok: true, woke: true }; }
  }
  if (action === 'spotify_restart' && (r.ok || r.status === 204)) await spotifyApi(channel, 'PUT', '/me/player/play'); // si estaba en pausa, que suene de nuevo
  if (r.ok || r.status === 204) { _ttlCache.delete('spotifydock:' + channel); return { ok: true }; }
  const body = await r.json().catch(() => null);
  const reason = body?.error?.reason, msg = String(body?.error?.message || '');
  if (r.status === 404) return { ok: false, error: 'nodevice' };
  if (r.status === 401) return { ok: false, error: 'reconnect' };
  if (r.status === 429) return { ok: false, error: 'rate' };
  if (r.status === 403) return { ok: false, error: reason === 'PREMIUM_REQUIRED' ? 'premium' : (/scope/i.test(msg) ? 'scope' : 'forbidden') };
  return { ok: false, error: 'fail' };
}

// ── Dock de OBS: panel de control para "Docks → Docks de navegador personalizados" ──
// Su propia clave (distinta a la del overlay) va en el link del dock; se puede regenerar (dock_rev) si se filtra.
function dockKey(channel, rev) {
  return crypto.createHmac('sha256', YT_OVERLAY_SECRET).update(`dock:${String(channel || '').toLowerCase()}:${Number(rev) || 0}`).digest('hex').slice(0, 32);
}
async function dockAuth(channel, key) {
  if (!channel || !isValidString(key, 80)) return null;
  const cfg = await ytReadConfig(channel);
  const a = Buffer.from(String(key)), b = Buffer.from(dockKey(channel, cfg.dock_rev));
  return (a.length === b.length && crypto.timingSafeEqual(a, b)) ? cfg : null;
}
const _dockHits = {};
function dockRateOk(channel) { // tope por canal: 40 acciones cada 10 s
  const now = Date.now(), arr = (_dockHits[channel] || []).filter(t => now - t < 10000);
  if (arr.length >= 40) { _dockHits[channel] = arr; return false; }
  arr.push(now); _dockHits[channel] = arr; return true;
}
app.get('/dock/:channel', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
  res.sendFile(path.join(__dirname, 'dock.html'));
});
app.get('/api/dock/url', async (req, res) => {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: 'No autorizado' });
  const u = username.toLowerCase();
  try {
    const cfg = await ytReadConfig(u);
    res.json({ ok: true, url: `${BASE_URL}/dock/${u}?key=${dockKey(u, cfg.dock_rev)}` });
  } catch (e) { res.json({ ok: false }); }
});
app.post('/api/dock/regenerate', async (req, res) => {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: 'No autorizado' });
  const u = username.toLowerCase();
  try {
    const r = await ytMutate(u, (cfg) => { cfg.dock_rev = (Number(cfg.dock_rev) || 0) + 1; });
    if (!r.ok) return res.json({ ok: false });
    res.json({ ok: true, url: `${BASE_URL}/dock/${u}?key=${dockKey(u, r.config.dock_rev)}` });
  } catch (e) { res.json({ ok: false }); }
});
app.get('/api/dock/:channel/state', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const channel = String(req.params.channel || '').toLowerCase();
  try {
    const cfg = await dockAuth(channel, req.query.key);
    if (!cfg) return res.status(403).json({ ok: false, error: 'key' });
    const st = ytLiveStatus[channel];
    const online = !!st && Date.now() - st.ts < 12000;
    const queue = (Array.isArray(cfg.queue) ? cfg.queue : []).slice(0, 25).map(q => ({
      videoId: q.videoId, title: String(q.title || '').slice(0, 200), requestedBy: q.requestedBy || null, durationSec: q.durationSec || null
    }));
    let spotify = { connected: false };
    try {
      spotify = req.query.spotify === '1' ? await spotifyDockState(channel) : { connected: await spotifyConnected(channel) };
    } catch (e) { spotify = { connected: true, error: 'fail' }; }
    res.json({
      ok: true, now: Date.now(), online, status: online ? st : null,
      queue, total: (cfg.queue || []).length, volume: cfg.volume ?? 100,
      shuffle: !!cfg.playlist_shuffle, loop: cfg.playlist_loop !== false, spotify
    });
  } catch (e) { res.status(500).json({ ok: false }); }
});
app.post('/api/dock/:channel/control', async (req, res) => {
  const channel = String(req.params.channel || '').toLowerCase();
  try {
    const cfg0 = await dockAuth(channel, req.body?.key || req.query.key);
    if (!cfg0) return res.status(403).json({ ok: false, error: 'key' });
    if (!dockRateOk(channel)) return res.status(429).json({ ok: false, error: 'rate' });
    const { action, value, videoId } = req.body || {};
    if (typeof action === 'string' && action.startsWith('spotify_')) return res.json(await spotifyDockControl(channel, action, value));
    if (!['pause', 'play', 'skip', 'volume', 'playnow', 'remove', 'clear'].includes(action)) return res.json({ ok: false, error: 'accion' });
    if (action === 'remove' && !isValidString(videoId, 20)) return res.json({ ok: false, error: 'videoId' });
    const r = await ytMutate(channel, (cfg) => {
      if (action === 'volume') {
        const v = parseInt(value);
        cfg.volume = Math.max(0, Math.min(100, isNaN(v) ? 0 : v)); // el volumen no toca player_command_ts (si no, el overlay repetiría el último comando)
      } else if (action === 'playnow') {
        cfg.force_next = true;
      } else if (action === 'clear') {
        cfg.queue = []; cfg.song_limits = {}; cfg.force_next = false;
        cfg.player_command = 'stop'; cfg.player_command_ts = Date.now();
      } else if (action === 'remove') {
        const idx = (cfg.queue || []).findIndex(q => q.videoId === videoId);
        if (idx < 0) return { abort: true, reason: 'gone' };
        const st = ytLiveStatus[channel];
        const playingNow = idx === 0 && st && Date.now() - st.ts < 12000 && st.source === 'viewer' && st.videoId === videoId;
        if (playingNow) { cfg.player_command = 'skip'; cfg.player_command_ts = Date.now(); return { skipped: true }; }
        ytRemoveFromQueue(cfg, idx);
      } else {
        cfg.player_command = action; cfg.player_command_ts = Date.now();
      }
    });
    res.json({ ok: r.ok || r.reason === 'gone', skipped: !!r.skipped });
  } catch (e) { res.json({ ok: false }); }
});

// Reproducir ya la primera canción de la cola (salta la playlist base)
app.post('/api/youtube/queue/playnow', async (req, res) => {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: 'No autorizado' });
  try {
    const r = await ytMutate(username.toLowerCase(), (cfg) => { cfg.force_next = true; });
    res.json({ ok: r.ok });
  } catch(e) { res.json({ ok: false }); }
});

// Quitar una canción concreta de la cola (libera el límite del usuario que la pidió)
app.post('/api/youtube/queue/remove', async (req, res) => {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: 'No autorizado' });
  const { videoId } = req.body || {};
  if (!isValidString(videoId, 20)) return res.json({ ok: false });
  try {
    const r = await ytMutate(username.toLowerCase(), (cfg) => {
      const idx = (cfg.queue || []).findIndex(q => q.videoId === videoId);
      if (idx < 0) return { abort: true, reason: 'gone' };
      // Si es la que está sonando AHORA en el overlay, se usa "saltar" para que la detenga.
      // Si solo está esperando (suena la playlist o el overlay está cerrado), se quita directo de la cola.
      const st = ytLiveStatus[username.toLowerCase()];
      const playingNow = idx === 0 && st && Date.now() - st.ts < 12000 && st.source === 'viewer' && st.videoId === videoId;
      if (playingNow) { cfg.player_command = 'skip'; cfg.player_command_ts = Date.now(); return { skipped: true }; }
      ytRemoveFromQueue(cfg, idx);
    });
    res.json({ ok: r.ok || r.reason === 'gone', skipped: !!r.skipped });
  } catch(e) { res.json({ ok: false }); }
});

// Vaciar la cola completa (libera todos los límites) — la canción que suena se detiene
app.post('/api/youtube/queue/clear', async (req, res) => {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: 'No autorizado' });
  try {
    const r = await ytMutate(username.toLowerCase(), (cfg) => {
      cfg.queue = []; cfg.song_limits = {}; cfg.force_next = false;
      cfg.player_command = 'stop'; cfg.player_command_ts = Date.now();
    });
    res.json({ ok: r.ok });
  } catch(e) { res.json({ ok: false }); }
});

app.post('/api/youtube/history/clear', async (req, res) => {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: 'No autorizado' });
  try {
    const r = await ytMutate(username.toLowerCase(), (cfg) => { cfg.history = []; });
    res.json({ ok: r.ok });
  } catch(e) { res.json({ ok: false }); }
});

// Volver a poner en cola una canción del historial (a nombre de quien la pidió, respetando que no esté repetida)
app.post('/api/youtube/history/requeue', async (req, res) => {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: 'No autorizado' });
  const { videoId } = req.body || {};
  if (!isValidString(videoId, 20)) return res.json({ ok: false });
  try {
    const r = await ytMutate(username.toLowerCase(), (cfg) => {
      const item = (cfg.history || []).find(h => h.videoId === videoId);
      if (!item) return { abort: true, reason: 'gone' };
      const queue = cfg.queue || [];
      if (queue.some(q => q.videoId === videoId)) return { abort: true, reason: 'dup' };
      queue.push({ videoId: item.videoId, title: item.title, channelTitle: item.channelTitle, requestedBy: username.toLowerCase(), addedAt: Date.now(), durationSec: item.durationSec });
      cfg.queue = queue;
      return { position: queue.length };
    });
    res.json({ ok: r.ok, reason: r.reason || null, position: r.position || null });
  } catch(e) { res.json({ ok: false }); }
});

// "Fijar mix": el dashboard lee la lista real del mix en el navegador del streamer (con su sesión de YouTube) y la guarda,
// para que el overlay de OBS reproduzca exactamente esas canciones
app.post('/api/youtube/mix-snapshot', async (req, res) => {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: 'No autorizado' });
  const { listId, ids } = req.body || {};
  if (!isValidString(listId, 60) || !/^RD[A-Za-z0-9_-]+$/.test(listId) || !isValidArray(ids)) return res.json({ ok: false, error: 'datos' });
  const clean = [...new Set(ids.filter(x => typeof x === 'string' && /^[A-Za-z0-9_-]{11}$/.test(x)))].slice(0, 200);
  if (!clean.length) return res.json({ ok: false, error: 'vacio' });
  try {
    const r = await ytMutate(username.toLowerCase(), (cfg) => { cfg.mix_snapshot = { listId, ids: clean, ts: Date.now() }; });
    if (r.ok) ytPlaylistInfo[username.toLowerCase()] = { ts: Date.now(), ok: true, fixed: true, total: clean.length, skipped: 0 };
    res.json({ ok: r.ok, count: clean.length });
  } catch(e) { res.json({ ok: false }); }
});

// Guardar ajustes — solo los campos permitidos; la cola, el historial y los límites nunca se tocan desde aquí
app.post('/api/youtube/config', async (req, res) => {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: 'No autorizado' });
  try {
    const settings = ytSanitizeSettings(req.body?.youtube_config);
    if (!Object.keys(settings).length) return res.json({ ok: false, error: 'vacio' });
    const r = await ytMutate(username.toLowerCase(), (cfg) => {
      Object.assign(cfg, settings);
    });
    res.json({ ok: r.ok });
  } catch(e) { res.json({ ok: false }); }
});

app.get('/overlay/shoutout/:username', async (req, res) => {
  try {
    res.sendFile(path.join(__dirname, 'shoutout-overlay.html'));
  } catch(e) { res.status(500).send('Error'); }
});

app.get('/api/shoutout/:username', async (req, res) => {
  const username = req.params.username.toLowerCase();
  try {
    const data = await fetch(`${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${username}&select=last_shoutout&limit=1`, { headers: sbHeaders });
    const streamer = (await data.json())?.[0];
    res.json(streamer?.last_shoutout || null);
  } catch(e) { res.status(500).json(null); }
});

// ── 404 ──
app.use((req, res) => {
  res.status(404).send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MuffetBot — Página no encontrada</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#0a0a0c;font-family:'Inter',sans-serif;color:#eeeef5;min-height:100vh;
  display:flex;align-items:center;justify-content:center;
  background-image:radial-gradient(ellipse 80% 50% at 50% 0%,rgba(145,71,255,0.08),transparent);}
.card{text-align:center;max-width:420px;padding:48px 32px;}
.spider{font-size:80px;margin-bottom:24px;display:block;animation:swing 3s ease-in-out infinite;}
@keyframes swing{0%,100%{transform:rotate(-8deg);}50%{transform:rotate(8deg);}}
.code{font-size:80px;font-weight:900;letter-spacing:-3px;line-height:1;
  background:linear-gradient(135deg,#fff,#b388ff,#9147ff);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
h1{font-size:22px;font-weight:700;margin:12px 0 10px;}
p{font-size:14px;color:#6b6b82;line-height:1.7;margin-bottom:32px;}
.btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}
a{padding:11px 24px;border-radius:20px;font-size:13px;font-weight:600;text-decoration:none;transition:all 0.15s;}
.btn-primary{background:#9147ff;color:white;box-shadow:0 0 20px rgba(145,71,255,0.3);}
.btn-primary:hover{background:#7d2ff7;}
.btn-ghost{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#6b6b82;}
.btn-ghost:hover{color:#eeeef5;border-color:rgba(255,255,255,0.2);}
</style>
</head>
<body>
<div class="card">
  <span class="spider">🕷️</span>
  <div class="code">404</div>
  <h1>¡Dearie, esta página no existe!</h1>
  <p>Parece que Muffet no puede encontrar lo que buscas.<br>Quizás la URL está mal o la página fue movida.</p>
  <div class="btns">
    <a href="/" class="btn-primary">🏠 Ir al inicio</a>
    <a href="/dashboard" class="btn-ghost">🎮 Dashboard</a>
  </div>
</div>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`🐻🕷️ Dashboard en puerto ${PORT} | Producción: ${IS_PROD}`));
