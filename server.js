const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();

// ══════════════════════════════════════════
//  CONFIGURACIÓN
// ══════════════════════════════════════════
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_KEY;
const TWITCH_CLIENT_ID  = process.env.TWITCH_CLIENT_ID;
const TWITCH_SECRET     = process.env.TWITCH_SECRET;
const SESSION_SECRET    = process.env.SESSION_SECRET || 'muffet-reino-secreto';
const BASE_URL          = process.env.BASE_URL || 'http://localhost:3000';
const PORT              = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ══════════════════════════════════════════
//  MIDDLEWARE
// ══════════════════════════════════════════
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ══════════════════════════════════════════
//  MIDDLEWARE DE AUTH
// ══════════════════════════════════════════
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  next();
}

// ══════════════════════════════════════════
//  RUTAS PÚBLICAS
// ══════════════════════════════════════════

// Página de login
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'login.html'));
});

// Iniciar login con Twitch
app.get('/auth/twitch', (req, res) => {
  const scopes = 'user:read:email';
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${BASE_URL}/auth/twitch/callback&response_type=code&scope=${scopes}`;
  res.redirect(url);
});

// Callback de Twitch OAuth
app.get('/auth/twitch/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/');

  try {
    // Obtener token de acceso
    const tokenRes = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${BASE_URL}/auth/twitch/callback`
      }
    });

    const accessToken = tokenRes.data.access_token;

    // Obtener datos del usuario
    const userRes = await axios.get('https://api.twitch.tv/helix/users', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client-Id': TWITCH_CLIENT_ID
      }
    });

    const twitchUser = userRes.data.data[0];

    // Buscar o crear streamer en Supabase
    let { data: streamer } = await supabase
      .from('streamers')
      .select('*')
      .eq('twitch_id', twitchUser.id)
      .single();

    if (!streamer) {
      // Crear nuevo streamer con valores por defecto
      const defaultCommands = {
        '!miel': '🍯🐻 ¡El Rey Oso tiene miel fresca para todos sus súbditos! ♥',
        '!té': '☕🕷️ ¡Aquí tienes tu té de araña con miel especial, dearie! 🐻♥',
        '!redes': '🐻👑 Síguenos en Twitch y redes sociales! 🕷️♥',
        '!cueva': '🐻🕷️ ¡Bienvenido a la Cueva del Rey! 👑♥',
        '!muffet': '🕷️ ¡Soy Muffet, la guardiana de la cueva del Rey Oso! 🐻👑♥',
      };

      const defaultAutoMessages = [
        '🐻👑 ¡Recuerden seguir el canal, súbditos! 🕷️♥',
        '🍯🕷️ ¡Escribe !miel o !té para recibir tu regalo! 🐻',
        '👑🕷️ ¿Preguntas? ¡Usa !ask y Muffet responde! 🐻♥',
      ];

      const defaultPrompt = `Eres Muffet, la araña de Undertale y guardiana de la cueva del Rey Oso. 
Los viewers son "súbditos del reino". 
Hablas en español, eres coqueta y misteriosa. 
Usas emojis 🕷️ 🐻 👑 ♥. 
Respuestas cortas (máximo 2 oraciones).`;

      const { data: newStreamer } = await supabase
        .from('streamers')
        .insert({
          twitch_id: twitchUser.id,
          twitch_username: twitchUser.login,
          bot_prompt: defaultPrompt,
          commands: defaultCommands,
          auto_messages: defaultAutoMessages,
          ai_enabled: true,
          mod_enabled: false,
          banned_words: [],
          warn_message: '⚠️ Cuidado, dearie~ 🕷️ Esa palabra no se usa en la cueva del Rey.',
          access_token: accessToken
        })
        .select()
        .single();

      streamer = newStreamer;
    } else {
      // Actualizar token
      await supabase
        .from('streamers')
        .update({ access_token: accessToken })
        .eq('twitch_id', twitchUser.id);
    }

    req.session.user = {
      id: twitchUser.id,
      username: twitchUser.login,
      display_name: twitchUser.display_name,
      avatar: twitchUser.profile_image_url,
      streamerId: streamer.id
    };

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Auth error:', err.message);
    res.redirect('/?error=auth');
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ══════════════════════════════════════════
//  RUTAS PROTEGIDAS
// ══════════════════════════════════════════

// Dashboard principal
app.get('/dashboard', requireAuth, async (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// API — obtener datos del streamer
app.get('/api/streamer', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('streamers')
    .select('*')
    .eq('twitch_id', req.session.user.id)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ streamer: data, user: req.session.user });
});

// API — guardar prompt
app.post('/api/prompt', requireAuth, async (req, res) => {
  const { prompt } = req.body;
  const { error } = await supabase
    .from('streamers')
    .update({ bot_prompt: prompt })
    .eq('twitch_id', req.session.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// API — guardar comandos
app.post('/api/commands', requireAuth, async (req, res) => {
  const { commands } = req.body;
  const { error } = await supabase
    .from('streamers')
    .update({ commands })
    .eq('twitch_id', req.session.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// API — guardar mensajes automáticos
app.post('/api/auto-messages', requireAuth, async (req, res) => {
  const { auto_messages } = req.body;
  const { error } = await supabase
    .from('streamers')
    .update({ auto_messages })
    .eq('twitch_id', req.session.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// API — toggle IA
app.post('/api/ai-toggle', requireAuth, async (req, res) => {
  const { enabled } = req.body;
  const { error } = await supabase
    .from('streamers')
    .update({ ai_enabled: enabled })
    .eq('twitch_id', req.session.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// API — guardar moderación
app.post('/api/moderation', requireAuth, async (req, res) => {
  const { mod_enabled, banned_words, warn_message } = req.body;
  const { error } = await supabase
    .from('streamers')
    .update({ mod_enabled, banned_words, warn_message })
    .eq('twitch_id', req.session.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ══════════════════════════════════════════
//  INICIAR SERVIDOR
// ══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`🐻🕷️ Dashboard corriendo en puerto ${PORT}`);
});
