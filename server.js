const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_SECRET    = process.env.TWITCH_SECRET;
const SESSION_SECRET   = process.env.SESSION_SECRET || 'muffet-secreto';
const BASE_URL         = process.env.BASE_URL || 'http://localhost:8080';
const PORT             = process.env.PORT || 8080;
const IS_PROD          = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

// ── Trust proxy para HTTPS en Render/Railway ──
app.set('trust proxy', 1);

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
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/auth/twitch', (req, res) => {
  const redirectUri = BASE_URL + '/auth/twitch/callback';
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=user:read:email`;
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
    const url = `${SUPABASE_URL}/rest/v1/streamers?twitch_username=eq.${username}&approved=eq.true&select=twitch_username,commands,social_links,youtube_channel_id&limit=1`;
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
    res.json({ username: streamer.twitch_username, commands: publicCmds, social_links: streamer.social_links || {}, youtube_channel_id: streamer.youtube_channel_id || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const url = `${SUPABASE_URL}/rest/v1/streamers?select=id,twitch_username,twitch_id,role,approved,plan,created_at,ai_enabled,mod_enabled&order=created_at.desc`;
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

// ── Overlay de sorteo para OBS ──
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
    const { social_links, youtube_channel_id } = req.body;
    if (!isValidObject(social_links)) return res.status(400).json({ error: 'Links inválidos' });
    const update = { social_links };
    if (youtube_channel_id !== undefined) update.youtube_channel_id = youtube_channel_id || null;
    await sbUpdate('streamers', update, { twitch_id: req.session.user.id });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/socials:', err.message);
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
