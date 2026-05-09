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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ── Supabase helpers usando fetch directo ──
async function sbSelect(table, filters = {}) {
  let query = Object.entries(filters).map(([k, v]) => `${k}=eq.${v}`).join('&');
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}&limit=1`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  const data = await res.json();
  return Array.isArray(data) ? data[0] || null : null;
}

async function sbInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(row)
  });
  const data = await res.json();
  console.log('Insert response:', res.status, JSON.stringify(data).substring(0, 200));
  return Array.isArray(data) ? data[0] : data;
}

async function sbUpdate(table, row, filters = {}) {
  let query = Object.entries(filters).map(([k, v]) => `${k}=eq.${v}`).join('&');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(row)
  });
  const data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  next();
}

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

    // 1. Token
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_SECRET, code, grant_type: 'authorization_code', redirect_uri: redirectUri }).toString()
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) { console.error('No token:', tokenData); return res.redirect('/?error=auth'); }
    const accessToken = tokenData.access_token;

    // 2. Usuario de Twitch
    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Client-Id': TWITCH_CLIENT_ID }
    });
    const userData = await userRes.json();
    const twitchUser = userData && userData.data && userData.data[0];
    if (!twitchUser) { console.error('No user:', userData); return res.redirect('/?error=auth'); }
    console.log('Logged in:', twitchUser.login);

    // 3. Supabase — buscar o crear
    let streamer = await sbSelect('streamers', { twitch_id: twitchUser.id });

    if (!streamer) {
      streamer = await sbInsert('streamers', {
        twitch_id: twitchUser.id,
        twitch_username: twitchUser.login,
        bot_prompt: `Eres Muffet, la araña de Undertale y guardiana de la cueva del Rey Oso. Los viewers son "súbditos del reino". Hablas en español, eres coqueta y misteriosa. Usas emojis 🕷️ 🐻 👑 ♥. Respuestas cortas (máximo 2 oraciones).`,
        commands: { '!miel': '🍯🐻 ¡Miel fresca para todos! ♥', '!té': '☕🕷️ ¡Té de araña con miel, dearie! 🐻♥', '!redes': '🐻👑 ¡Síguenos! 🕷️♥', '!cueva': '🐻🕷️ ¡Bienvenido a la Cueva del Rey! 👑♥', '!muffet': '🕷️ ¡Soy Muffet, guardiana del reino! 🐻👑♥' },
        auto_messages: ['🐻👑 ¡Sigan el canal, súbditos! 🕷️♥', '🍯🕷️ ¡Escribe !miel o !té! 🐻', '👑🕷️ ¡Usa !ask para preguntarme! 🐻♥'],
        ai_enabled: true,
        mod_enabled: false,
        banned_words: [],
        warn_message: '⚠️ Cuidado, dearie~ 🕷️',
        access_token: accessToken
      });
      console.log('Created streamer');
    } else {
      await sbUpdate('streamers', { access_token: accessToken }, { twitch_id: twitchUser.id });
      console.log('Updated streamer');
    }

    if (!streamer || !streamer.id) { console.error('Streamer null after insert/select'); return res.redirect('/?error=auth'); }

    req.session.user = {
      id: twitchUser.id,
      username: twitchUser.login,
      display_name: twitchUser.display_name,
      avatar: twitchUser.profile_image_url,
      streamerId: streamer.id
    };

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Auth exception:', err.message);
    res.redirect('/?error=auth');
  }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

app.get('/api/streamer', requireAuth, async (req, res) => {
  const streamer = await sbSelect('streamers', { twitch_id: req.session.user.id });
  if (!streamer) return res.status(500).json({ error: 'Not found' });
  res.json({ streamer, user: req.session.user });
});

app.post('/api/prompt', requireAuth, async (req, res) => {
  await sbUpdate('streamers', { bot_prompt: req.body.prompt }, { twitch_id: req.session.user.id });
  res.json({ success: true });
});

app.post('/api/commands', requireAuth, async (req, res) => {
  await sbUpdate('streamers', { commands: req.body.commands }, { twitch_id: req.session.user.id });
  res.json({ success: true });
});

app.post('/api/auto-messages', requireAuth, async (req, res) => {
  await sbUpdate('streamers', { auto_messages: req.body.auto_messages }, { twitch_id: req.session.user.id });
  res.json({ success: true });
});

app.post('/api/ai-toggle', requireAuth, async (req, res) => {
  await sbUpdate('streamers', { ai_enabled: req.body.enabled }, { twitch_id: req.session.user.id });
  res.json({ success: true });
});

app.post('/api/moderation', requireAuth, async (req, res) => {
  const { mod_enabled, banned_words, warn_message } = req.body;
  await sbUpdate('streamers', { mod_enabled, banned_words, warn_message }, { twitch_id: req.session.user.id });
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`🐻🕷️ Dashboard en puerto ${PORT}`));
