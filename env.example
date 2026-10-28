<div align="center">

# 🕷️ SilklyBot Dashboard

**Panel de control web de SilklyBot**: conecta tu canal de Twitch, personaliza a Muffet y configura todas sus funciones sin tocar código.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)](https://expressjs.com)
[![Supabase](https://img.shields.io/badge/Database-Supabase-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com)
[![License](https://img.shields.io/badge/License-Todos_los_derechos_reservados-red.svg)](LICENSE)

[Probar el dashboard](https://silklybot.com) · [Repo del Bot](https://github.com/ElOsoKing/muffet-bot) · [Reportar un bug](../../issues)

</div>

---

## 🎬 ¿Qué es esto?

Es el panel de control web de **[SilklyBot](https://github.com/ElOsoKing/muffet-bot)**, el chatbot de Twitch con la personalidad de Muffet. Desde aquí cualquier streamer puede:

- Conectar su cuenta de Twitch con un clic (OAuth)
- Personalizar la personalidad del bot con un prompt propio
- Activar y configurar cada función (Emoji Game, Subatón, Alertas Multimedia, Primerin, música, moderación, sorteos, etc.)
- Copiar overlays listos para OBS
- Administrar comandos personalizados, puntos, niveles y rankings
- Conectar su propio bot con un clic y darle la insignia de bot
- Exportar e importar su configuración como respaldo

## ✨ Funciones del dashboard

| Sección | Qué hace |
|---|---|
| 🎭 **Personalidad** | Editor del prompt de IA que define cómo habla el bot en tu canal |
| 🎬 **Emoji Game** | Categorías, puntos, cooldowns y reto automático |
| ⏱️ **Subatón** | Control en vivo (iniciar, pausar, ajustar tiempo) y minutos por evento |
| 🔊 **Alertas multimedia** | Sube audios o videos y vincúlalos a recompensas de puntos |
| 🎵 **Música** | Spotify o YouTube, límites por usuario, lista negra |
| 🛡️ **Moderación** | Palabras prohibidas, modo lento, anti-spam, moderación con IA |
| 🥇 **Primerin** | Sistema de "quién llega primero" |
| 🤝 **Bot propio** | "Conectar mi bot" con un clic, con renovación automática del token |
| 🏅 **Insignia de bot** | Autoriza a Muffet para enviar mensajes con la insignia en tu canal |
| 🎨 **Overlays** | Vista previa en vivo antes de ponerlos en OBS |
| 📊 **Comandos del sistema** | Activa o desactiva cada comando individualmente |

## 🧠 Arquitectura

Este servidor cumple varios roles:

1. **Backend del dashboard**: sirve las páginas y la API del panel (Express + sesiones).
2. **OAuth de Twitch**: login, autorización del bot propio y de la insignia, y renovación de tokens. Los enlaces firmados usan HMAC con caducidad.
3. **Receptor de EventSub**: recibe webhooks de Twitch (canjes, follows) y los reenvía al bot.
4. **Servidor de overlays**: páginas para Browser Source en OBS (Spotify, YouTube, Shoutout, Alertas Multimedia, Subatón, Sorteos).
5. **Planes y pagos**: suscripciones gestionadas con Lemon Squeezy.

Toda la configuración está en **Supabase**, la misma base de datos que usa el bot.

## 🛠️ Stack técnico

- **Backend:** Node.js + Express
- **Base de datos:** [Supabase](https://supabase.com) (Postgres + Storage)
- **Frontend:** HTML/CSS/JS vanilla, sin framework
- **Auth:** OAuth 2.0 de Twitch
- **Hosting:** [Render](https://render.com), con dominio propio

## 🚀 Este proyecto es un servicio, no un self-host

Si eres streamer y quieres usar SilklyBot en tu canal, no necesitas clonar ni desplegar nada: entra a **[silklybot.com](https://silklybot.com)** y conecta tu cuenta de Twitch.

Este repositorio es público por transparencia y como parte del portafolio del proyecto.

> Proyecto independiente y hecho por un fan. No está afiliado ni respaldado por Twitch.

## 📄 Licencia

Este código se comparte públicamente por transparencia y no está bajo una licencia de código abierto. **Todos los derechos reservados.** Ver [LICENSE](LICENSE).

---

<div align="center">
<sub>Hecho con 🕷️ y demasiado café por <a href="https://github.com/ElOsoKing">ElOsoKing</a></sub>
</div>
