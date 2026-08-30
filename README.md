# Инструкция по бесплатному деплою сервера Iris на Render.com

## Шаг 1: Загрузка репозитория на GitHub
1. Создайте новый репозиторий на GitHub (например, `iris-cloud-server`).
2. Загрузите файлы из папки `server/` в ваш репозиторий:
   - `server.py`
   - `requirements.txt`
   - `Procfile`
   - `render.yaml`
   - `Dockerfile`

## Шаг 2: Создание Web Service на Render.com (Бесплатно)
1. Зарегистрируйтесь на [Render.com](https://render.com/).
2. Нажмите **New +** -> **Web Service**.
3. Подключите ваш GitHub репозиторий `iris-cloud-server`.
4. Настройки:
   - **Name**: `iris-cloud-service` (или любое ваше имя)
   - **Region**: Frankfurt (EU) или любой другой
   - **Branch**: `main`
   - **Runtime**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn server:app --host 0.0.0.0 --port $PORT`
   - **Plan**: `Free` (0$/месяц)
5. Нажмите **Create Web Service**. Через 1-2 минуты сервис запустится и выдаст вам URL (например: `https://iris-cloud-service.onrender.com`).

## Шаг 3: Настройка UptimeRobot (чтобы бесплатный сервер никогда не засыпал)
1. Зарегистрируйтесь на [UptimeRobot.com](https://uptimerobot.com/) (бесплатно).
2. Нажмите **Add New Monitor**:
   - **Monitor Type**: `HTTP(s)`
   - **Friendly Name**: `Iris Server Ping`
   - **URL (or IP)**: `https://ваш-сервис.onrender.com/ping`
   - **Monitoring Interval**: `5 minutes`
3. Нажмите **Create Monitor**. Теперь UptimeRobot каждые 5 минут будет слать пинг, и Render.com никогда не уйдет в спящий режим!

## Шаг 4: Указание URL в клиенте (если отличается от дефолтного)
Клиент по умолчанию настроен на ваш URL или локальный хост. Вы также можете указать URL в настройках клиента или в коде `IrisCloudClient.java`.
