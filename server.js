const express = require('express');
const session = require('express-session');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_SECRET    = process.env.TWITCH_SECRET;
const SESSION_SECRET   = process.env.SESSION_SECRET || 'muffet-secreto';
const BASE_URL         = process.env.BASE_URL || 'http://localhost:8080';
const PORT             = process.env.PORT || 8080;

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
  const redirectUri = BASE_URL + '/auth/twitch/callback';
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=user:read:email`;
  console.log('Auth URL:', url);
  res.redirect(url);
});

app.get('/auth/twitch/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    console.error('OAuth error:', error || 'no code');
    return res.redirect('/?error=auth');
  }

  try {
    const redirectUri = BASE_URL + '/auth/twitch/callback';

    // 1. Obtener token
    const tokenParams = new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    });

    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString()
    });

    const tokenData = await tokenRes.json();
    console.log('Token status:', tokenRes.status);

    if (!tokenData.access_token) {
      console.error('No access token:', JSON.stringify(tokenData));
      return res.redirect('/?error=auth');
    }

    const accessToken = tokenData.access_token;
    console.log('Got access token: YES');

    // 2. Obtener usuario
    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client-Id': TWITCH_CLIENT_ID
      }
    });

    const userData = await userRes.json();
    console.log('User status:', userRes.status, '| Data:', JSON.stringify(userData));

    const twitchUser = userData && userData.data && userData.data[0];
    if (!twitchUser) {
      console.error('No user data');
      return res.redirect('/?error=auth');
    }

    console.log('Logged in as:', twitchUser.login);

    // 3. Buscar o crear en Supabase
    let { data: streamer, error: fetchError } = await supabase
      .from('streamers')
      .select('*')
      .eq('twitch_id', twitchUser.id)
      .single();

    if (!streamer) {
      const { data: newStreamer, error: insertError } = await supabase
        .from('streamers')
        .insert({
          twitch_id: twitchUser.id,
          twitch_username: twitchUser.login,
          bot_prompt: `Eres Muffet, la araña de Undertale y guardiana de la cueva del Rey Oso. Los viewers son "súbditos del reino". Hablas en español, eres coqueta y misteriosa. Usas emojis 🕷️ 🐻 👑 ♥. Respuestas cortas (máximo 2 oraciones).`,
          commands: {
            '!miel': '🍯🐻 ¡El Rey Oso tiene miel fresca para todos sus súbditos! ♥',
            '!té': '☕🕷️ ¡Aquí tienes tu té de araña con miel especial, dearie! 🐻♥',
            '!redes': '🐻👑 ¡Síguenos en Twitch y redes sociales! 🕷️♥',
            '!cueva': '🐻🕷️ ¡Bienvenido a la Cueva del Rey! 👑♥',
            '!muffet': '🕷️ ¡Soy Muffet, la guardiana de la cueva del Rey Oso! 🐻👑♥'
          },
          auto_messages: [
            '🐻👑 ¡Recuerden seguir el canal, súbditos! 🕷️♥',
            '🍯🕷️ ¡Escribe !miel o !té para recibir tu regalo! 🐻',
            '👑🕷️ ¿Preguntas? ¡Usa !ask y Muffet responde! 🐻♥'
          ],
          ai_enabled: true,
          mod_enabled: false,
          banned_words: [],
          warn_message: '⚠️ Cuidado, dearie~ 🕷️ Esa palabra no se usa en la cueva del Rey.',
          access_token: accessToken
        })
        .select()
        .single();

      if (insertError) {
        console.error('Insert error:', JSON.stringify(insertError));
        return res.redirect('/?error=auth');
      }
      streamer = newStreamer;
      console.log('Created streamer:', twitchUser.login);
    } else {
      await supabase.from('streamers').update({ access_token: accessToken }).eq('twitch_id', twitchUser.id);
      console.log('Updated streamer:', twitchUser.login);
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
    console.error('Auth exception:', err.message, err.stack);
    res.redirect('/?error=auth');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/api/streamer', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('streamers').select('*').eq('twitch_id', req.session.user.id).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ streamer: data, user: req.session.user });
});

app.post('/api/prompt', requireAuth, async (req, res) => {
  const { error } = await supabase.from('streamers').update({ bot_prompt: req.body.prompt }).eq('twitch_id', req.session.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/commands', requireAuth, async (req, res) => {
  const { error } = await supabase.from('streamers').update({ commands: req.body.commands }).eq('twitch_id', req.session.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/auto-messages', requireAuth, async (req, res) => {
  const { error } = await supabase.from('streamers').update({ auto_messages: req.body.auto_messages }).eq('twitch_id', req.session.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/ai-toggle', requireAuth, async (req, res) => {
  const { error } = await supabase.from('streamers').update({ ai_enabled: req.body.enabled }).eq('twitch_id', req.session.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/moderation', requireAuth, async (req, res) => {
  const { mod_enabled, banned_words, warn_message } = req.body;
  const { error } = await supabase.from('streamers').update({ mod_enabled, banned_words, warn_message }).eq('twitch_id', req.session.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`🐻🕷️ Dashboard corriendo en puerto ${PORT}`));
