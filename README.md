# Iris Cloud & Realtime IRC Server (Node.js)

Высокопроизводительный сервер на **Node.js (Express + WebSocket + SQLite)** для синхронизации облачных конфигов, списков друзей и живого IRC-чата в клиенте.

---

## 🚀 Быстрый деплой на Render.com (Бесплатно)

1. Загрузите файлы из папки `server/` в ваш GitHub-репозиторий:
   - `index.js`
   - `package.json`
   - `render.yaml`
   - `Procfile`
   - `Dockerfile`
2. Перейдите на [render.com](https://render.com/) и создайте **New Web Service**:
   * **Language / Environment**: `Node`
   * **Region**: `Frankfurt (EU)` (для минимального пинга)
   * **Build Command**: `npm install`
   * **Start Command**: `node index.js`
   * **Plan**: `Free`
3. Нажмите **Deploy Web Service**.

---

## 🔄 Подключение к UptimeRobot (24/7 без засыпания)

1. Перейдите на [uptimerobot.com](https://uptimerobot.com/) и создайте новый монитор:
   * **Monitor Type**: `HTTP(s)`
   * **Friendly Name**: `Iris Cloud Server`
   * **URL (or IP)**: `https://your-service-name.onrender.com/ping`
   * **Monitoring Interval**: `5 minutes`
   * **HTTP Method**: `HEAD` или `GET` (поддерживаются оба)
2. Нажмите **Create Monitor**. Теперь ваш сервер никогда не будет выключаться.
