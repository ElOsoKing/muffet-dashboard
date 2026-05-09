const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_KEY;
const TWITCH_CLIENT_ID  = process.env.TWITCH_CLIENT_ID;
const TWITCH_SECRET     = process.env.TWITCH_SECRET;
const SESSION_SECRET    = process.env.SESSION_SECRET || 'muffet-reino-secreto';
const BASE_URL          = process.env.BASE_URL || 'http://localhost:8080';
const PORT              = process.env.PORT || 8080;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  next();
}

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/auth/twitch', (req, res) => {
  const scopes = 'user:read:email';
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE_URL + '/auth/twitch/callback')}&response_type=code&scope=${scopes}`;
  console.log('Redirecting to Twitch:', url);
  res.redirect(url);
});

app.get('/auth/twitch/callback', async (req, res) => {
  const { code, error } = req.query;
  
  if (error) {
    console.error('Twitch OAuth error:', error);
    return res.redirect('/?error=auth');
  }
  
  if (!code) {
    console.error('No code received');
    return res.redirect('/?error=auth');
  }

  try {
    console.log('Getting token with code:', code.substring(0, 10) + '...');
    
    const tokenRes = await axios.post('https://id.twitch.tv/oauth2/token', new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_SECRET,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: BASE_URL + '/auth/twitch/callback'
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const accessToken = tokenRes.data.access_token;
    console.log('Got access token:', accessToken ? 'YES' : 'NO');

    const userRes = await axios.get('https://api.twitch.tv/helix/users', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client-Id': TWITCH_CLIENT_ID
      }
    });

    console.log('User response:', JSON.stringify(userRes.data));
    
    const twitchUser = userRes.data && userRes.data.data && userRes.data.data[0];
    
    if (!twitchUser) {
      console.error('No user data received from Twitch');
      return res.redirect('/?error=auth');
    }

    console.log('Twitch user:', twitchUser.login);

    let { data: streamer, error: fetchError } = await supabase
      .from('streamers')
      .select('*')
      .eq('twitch_id', twitchUser.id)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error('Supabase fetch error:', fetchError);
    }

    if (!streamer) {
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

      const defaultPrompt = `Eres Muffet, la araña de Undertale y guardiana de la cueva del Rey Oso. Los viewers son "súbditos del reino". Hablas en español, eres coqueta y misteriosa. Usas emojis 🕷️ 🐻 👑 ♥. Respuestas cortas (máximo 2 oraciones).`;

      const { data: newStreamer, error: insertError } = await supabase
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

      if (insertError) {
        console.error('Supabase insert error:', insertError);
        return res.redirect('/?error=auth');
      }

      streamer = newStreamer;
      console.log('Created new streamer:', twitchUser.login);
    } else {
      await supabase
        .from('streamers')
        .update({ access_token: accessToken })
        .eq('twitch_id', twitchUser.id);
      console.log('Updated existing streamer:', twitchUser.login);
    }

    req.session.user = {
      id: twitchUser.id,
      username: twitchUser.login,
      display_name: twitchUser.display_name,
      avatar: twitchUser.profile_image_url,
      streamerId: streamer.id
    };

    console.log('Login successful for:', twitchUser.login);
    res.redirect('/dashboard');
    
  } catch (err) {
    console.error('Auth error details:', err.response ? JSON.stringify(err.response.data) : err.message);
    res.redirect('/?error=auth');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/dashboard', requireAuth, async (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/api/streamer', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('streamers')
    .select('*')
    .eq('twitch_id', req.session.user.id)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ streamer: data, user: req.session.user });
});

app.post('/api/prompt', requireAuth, async (req, res) => {
  const { prompt } = req.body;
  const { error } = await supabase
    .from('streamers')
    .update({ bot_prompt: prompt })
    .eq('twitch_id', req.session.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/commands', requireAuth, async (req, res) => {
  const { commands } = req.body;
  const { error } = await supabase
    .from('streamers')
    .update({ commands })
    .eq('twitch_id', req.session.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/auto-messages', requireAuth, async (req, res) => {
  const { auto_messages } = req.body;
  const { error } = await supabase
    .from('streamers')
    .update({ auto_messages })
    .eq('twitch_id', req.session.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/ai-toggle', requireAuth, async (req, res) => {
  const { enabled } = req.body;
  const { error } = await supabase
    .from('streamers')
    .update({ ai_enabled: enabled })
    .eq('twitch_id', req.session.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/moderation', requireAuth, async (req, res) => {
  const { mod_enabled, banned_words, warn_message } = req.body;
  const { error } = await supabase
    .from('streamers')
    .update({ mod_enabled, banned_words, warn_message })
    .eq('twitch_id', req.session.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`🐻🕷️ Dashboard corriendo en puerto ${PORT}`);
});
