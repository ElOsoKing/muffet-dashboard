const express = require('express');
const session = require('express-session');
const path = require('path');

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

app.use(express.json({ limit: '50kb' })); // limitar payload
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

async function sbSelect(table, filters = {}) {
  const query = Object.entries(filters).map(([k,v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&limit=1`, { headers: sbHeaders });
  const data = await res.json();
  return Array.isArray(data) ? data[0] || null : null;
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
  const scopes = 'user:read:email channel:manage:broadcast clips:edit';
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}`;
  res.redirect(url);
});

app.get('/auth/twitch/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?error=auth');

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

    let streamer = await sbSelect('streamers', { twitch_id: twitchUser.id });

    // Tu cuenta es siempre admin y aprobada
    const isAdmin = twitchUser.login.toLowerCase() === 'elosoking1';

    if (!streamer) {
      streamer = await sbInsert('streamers', {
        twitch_id: twitchUser.id,
        twitch_username: twitchUser.login,
        bot_prompt: `Eres Muffet, la araña de Undertale. Eres la consejera y asistente del canal de ${twitchUser.display_name}. Los viewers son "súbditos" o "dearies". Hablas en español, eres coqueta y misteriosa. Usas emojis 🕷️ 👑 ♥. Respuestas cortas (máximo 2 oraciones).`,
        commands: { '!miel': '🍯 ¡Miel fresca para todos! ♥', '!muffet': '🕷️ ¡Soy Muffet, consejera del canal! 👑♥', '!redes': '👑 ¡Síguenos en redes! 🕷️♥' },
        auto_messages: ['👑 ¡Recuerden seguir el canal! 🕷️♥', '🕷️ ¡Usa !ask para preguntarme! ♥'],
        ai_enabled: true, mod_enabled: false, banned_words: [],
        warn_message: '⚠️ Cuidado, dearie~ 🕷️',
        access_token: tokenData.access_token,
        role: isAdmin ? 'admin' : 'pending',
        approved: isAdmin ? true : false,
      });
    } else {
      await sbUpdate('streamers', { access_token: tokenData.access_token }, { twitch_id: twitchUser.id });
    }

    if (!streamer?.id) { console.error('Streamer null'); return res.redirect('/?error=auth'); }

    req.session.user = {
      id: twitchUser.id,
      username: twitchUser.login,
      display_name: twitchUser.display_name,
      avatar: twitchUser.profile_image_url,
      streamerId: streamer.id,
      role: streamer.role || 'pending',
      approved: streamer.approved || false,
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
app.get('/canal/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    const url = `${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${username}&approved=eq.true&limit=1`;
    const result = await fetch(url, { headers: sbHeaders });
    const data = await result.json();
    const streamer = data?.[0];
    if (!streamer) return res.status(404).send('Canal no encontrado');
    res.sendFile(path.join(__dirname, 'canal.html'));
  } catch (err) {
    res.status(500).send('Error');
  }
});

// API pública del canal
app.get('/api/canal/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    const url = `${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${username}&approved=eq.true&select=twitch_username,public_name,commands,social_links,youtube_channel_id,points_config,viewer_points,stream_schedule&limit=1`;
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
      stream_schedule: streamer.stream_schedule || null
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

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// API admin — obtener todos los streamers
app.get('/api/admin/streamers', requireAdmin, async (req, res) => {
  try {
    const url = `${SUPABASE_URL}/rest/v1/streamers?select=id,twitch_username,twitch_id,role,approved,plan,created_at,ai_enabled,mod_enabled,custom_bot_username,commands,auto_messages,viewer_points,command_stats&order=created_at.desc`;
    const result = await fetch(url, { headers: sbHeaders });
    const data = await result.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API admin — aprobar streamer
app.post('/api/admin/approve/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await fetch(`${SUPABASE_URL}/rest/v1/streamers?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...sbHeaders, 'Prefer': 'return=representation' },
      body: JSON.stringify({ approved: true, role: 'streamer' })
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API admin — revocar acceso
app.post('/api/admin/revoke/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await fetch(`${SUPABASE_URL}/rest/v1/streamers?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...sbHeaders, 'Prefer': 'return=representation' },
      body: JSON.stringify({ approved: false, role: 'blocked' })
    });
    res.json({ success: true });
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
    await fetch(`${SUPABASE_URL}/rest/v1/streamers?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...sbHeaders, 'Prefer': 'return=representation' },
      body: JSON.stringify({ role, approved: role !== 'pending' && role !== 'blocked' })
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
//  RUTAS PROTEGIDAS
// ══════════════════════════════════════════
app.get('/plans', (req, res) => res.sendFile(path.join(__dirname, 'plans.html')));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// API admin — activar plan pro
app.post('/api/admin/plan/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { plan } = req.body;
    if (!['free','pro'].includes(plan)) return res.status(400).json({ error: 'Plan inválido' });
    await fetch(`${SUPABASE_URL}/rest/v1/streamers?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...sbHeaders, 'Prefer': 'return=representation' },
      body: JSON.stringify({ plan })
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/streamer', requireAuth, async (req, res) => {
  try {
    const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
    if (!streamer) return res.status(404).json({ error: 'Streamer no encontrado' });
    res.json({ streamer, user: { ...req.session.user, role: streamer.role } });
  } catch (err) {
    console.error('GET /api/streamer:', err.message);
    res.status(500).json({ error: 'Error del servidor' });
  }
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
    await sbUpdate('streamers', { commands }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/commands:', err.message);
    res.status(500).json({ error: 'Error al guardar' });
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
    await sbUpdate('streamers', { custom_bot_username, custom_bot_token }, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API — eliminar bot personalizado
app.delete('/api/custom-bot', requireAuth, async (req, res) => {
  try {
    await sbUpdate('streamers', { custom_bot_username: null, custom_bot_token: null }, { twitch_id: req.session.user.id });
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
    // Enviar evento al bot
    const botUrl = `http://localhost:${process.env.BOT_PORT || 3001}/event`;
    fetch(botUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.BOT_SECRET || 'muffetbot-internal-2026', type: body.subscription?.type, event: body.event })
    }).catch(() => {});
  }
  res.status(204).send();
});

async function getTwitchAppToken() {
  const res = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_SECRET}&grant_type=client_credentials`, { method: 'POST' });
  const data = await res.json();
  return data.access_token;
}

async function registerEventSub(broadcasterId, appToken) {
  const webhookUrl = `${BASE_URL}/webhook/twitch`;
  const subs = [
    { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId } },
    { type: 'channel.subscribe', version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.subscription.gift', version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.cheer', version: '1', condition: { broadcaster_user_id: broadcasterId } },
  ];
  for (const sub of subs) {
    try {
      await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${appToken}`, 'Client-Id': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sub, transport: { method: 'webhook', callback: webhookUrl, secret: EVENTSUB_SECRET } })
      });
    } catch(e) {}
  }
}

app.post('/api/eventsub/register', requireAuth, async (req, res) => {
  try {
    const appToken = await getTwitchAppToken();
    await registerEventSub(req.session.user.id, appToken);
    res.json({ success: true });
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

// ── API Último clip ──
app.get('/api/clips/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    const url = `${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${username}&approved=eq.true&select=twitch_id,access_token&limit=1`;
    const result = await fetch(url, { headers: sbHeaders });
    const data = await result.json();
    const streamer = data?.[0];
    if (!streamer?.access_token) return res.json([]);

    const r = await fetch(`https://api.twitch.tv/helix/clips?broadcaster_id=${streamer.twitch_id}&first=4`, {
      headers: { 'Authorization': `Bearer ${streamer.access_token}`, 'Client-Id': TWITCH_CLIENT_ID }
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
  res.sendFile(path.join(__dirname, 'spotify-overlay.html'));
});

app.get('/api/overlay/spotify/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const streamer = await sbSelect('streamers', { twitch_username: username.toLowerCase() });
    if (!streamer?.spotify_token) return res.json({ playing: false });

    let token = streamer.spotify_token;
    let r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (r.status === 401 && streamer.spotify_refresh) {
      token = await refreshSpotifyToken(streamer.spotify_refresh, streamer.spotify_client_id, streamer.spotify_client_secret);
      if (token) {
        await sbUpdate('streamers', { spotify_token: token }, { twitch_username: username.toLowerCase() });
        r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', { headers: { 'Authorization': `Bearer ${token}` } });
      }
    }
    if (r.status === 204 || !r.ok) return res.json({ playing: false });
    const data = await r.json();
    if (!data.item) return res.json({ playing: false });
    res.json({
      playing: true,
      track: data.item.name,
      artist: data.item.artists.map(a => a.name).join(', '),
      album: data.item.album.name,
      image: data.item.album.images?.[1]?.url || data.item.album.images?.[0]?.url || '',
      progress_ms: data.progress_ms,
      duration_ms: data.item.duration_ms,
      is_playing: data.is_playing
    });
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

app.post('/api/counters', requireAuth, async (req, res) => {
  try {
    const { counters } = req.body;
    if (!isValidObject(counters)) return res.status(400).json({ error: 'Inválido' });
    await sbUpdate('streamers', { counters }, { twitch_id: req.session.user.id });
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

app.get('/overlay/sorteo/:username', (req, res) => {
  res.sendFile(path.join(__dirname, 'raffle-overlay.html'));
});

app.get('/api/raffle/overlay/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    const url = `${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${username}&approved=eq.true&select=raffle_active,raffle_settings&limit=1`;
    const result = await fetch(url, { headers: sbHeaders });
    const data = await result.json();
    const streamer = data?.[0];
    if (!streamer) return res.status(404).json({ error: 'Canal no encontrado' });
    const raffle = streamer.raffle_active || {};
    const join_cmd = streamer.raffle_settings?.join_cmd || '!entrar';
    res.json({ active: !!raffle.active, prize: raffle.prize || '', participants: raffle.participants || [], winner: raffle.winner || null, join_cmd });
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
    const botUrl = `http://localhost:${process.env.BOT_PORT || 3001}/event`;
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

app.listen(PORT, () => console.log(`🐻🕷️ Dashboard en puerto ${PORT} | Producción: ${IS_PROD}`));
