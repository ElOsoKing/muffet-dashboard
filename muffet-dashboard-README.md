<div align="center">

# 🐻🕷️ MuffetBot Dashboard

**Panel de control web para MuffetBot** — conecta tu canal de Twitch, personaliza a Muffet y configura todas sus funciones sin tocar código.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)](https://expressjs.com)
[![Supabase](https://img.shields.io/badge/Database-Supabase-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com)
[![License](https://img.shields.io/badge/License-Todos_los_derechos_reservados-red.svg)](LICENSE)

[Probar el dashboard](https://muffet-dashboard.onrender.com) · [Repo del Bot](https://github.com/ElOsoKing/muffet-bot) · [Reportar un bug](../../issues)

</div>

---

## 🎬 ¿Qué es esto?

Este es el panel de control web de **[MuffetBot](https://github.com/ElOsoKing/muffet-bot)**, el chatbot de Twitch con personalidad propia. Desde aquí, cualquier streamer puede:

- Conectar su cuenta de Twitch con un solo click (OAuth)
- Personalizar por completo la personalidad de su bot con un prompt propio
- Activar y configurar cada función del bot (Emoji Game, Subatón, Alertas Multimedia, Primerin, música, moderación, sorteos, etc.)
- Ver overlays listos para copiar y pegar directo en OBS
- Administrar comandos personalizados, puntos, niveles y rankings
- Exportar/importar su configuración como respaldo

## ✨ Funciones del dashboard

| Sección | Qué hace |
|---|---|
| 🎭 **Personalidad** | Editor del prompt de IA que define cómo habla el bot en tu canal |
| 🎬 **Emoji Game** | Configurar categorías, puntos, cooldowns y reto automático |
| ⏱️ **Subatón** | Control en vivo (iniciar, pausar, ajustar tiempo) + configuración de minutos por evento |
| 🔊 **Alertas multimedia** | Subir audios/videos y vincularlos a recompensas de puntos del canal |
| 🎵 **Música** | Conectar Spotify o YouTube, límites por usuario, lista negra |
| 🛡️ **Moderación** | Palabras prohibidas, modo lento, anti-spam, moderación con IA |
| 🥇 **Primerin** | Configurar el sistema de "quién llega primero" al stream |
| 🎨 **Overlays** | Vista previa en vivo de cada overlay antes de ponerlo en OBS |
| 📊 **Comandos del sistema** | Activar/desactivar cada comando del bot individualmente |

## 🧠 Arquitectura

Este servidor cumple varios roles:

1. **Backend del dashboard** — sirve las páginas y la API que usa el panel de control (Express + sesiones)
2. **OAuth de Twitch** — maneja el login y renovación automática de tokens
3. **Receptor de EventSub** — recibe webhooks de Twitch (canjes de puntos, follows) y se los reenvía al bot
4. **Servidor de overlays** — sirve las páginas que se usan como Browser Source en OBS (Spotify, YouTube, Shoutout, Alertas Multimedia, Subatón, Sorteos)

Toda la configuración se guarda en **Supabase**, la misma base de datos que consulta el bot.

## 🛠️ Stack técnico

- **Backend:** Node.js + Express
- **Base de datos:** [Supabase](https://supabase.com) (Postgres + Storage)
- **Frontend:** HTML/CSS/JS vanilla (sin framework, todo servido directo)
- **Auth:** OAuth 2.0 de Twitch
- **Hosting:** [Render](https://render.com)

## 🚀 Este proyecto es un servicio, no un self-host

Si eres streamer y quieres usar MuffetBot en tu canal, no necesitas clonar ni desplegar nada — solo entra a **[muffet-dashboard.onrender.com](https://muffet-dashboard.onrender.com)** y conecta tu cuenta de Twitch.

Este repositorio es público por transparencia y como parte del portafolio del proyecto.

## 📄 Licencia

Este código se comparte públicamente por transparencia — no está bajo una licencia de código abierto. **Todos los derechos reservados.** Ver [LICENSE](LICENSE) para más detalles.

---

<div align="center">
<sub>Hecho con 🕷️ y demasiado café por <a href="https://github.com/ElOsoKing">ElOsoKing</a></sub>
</div>
