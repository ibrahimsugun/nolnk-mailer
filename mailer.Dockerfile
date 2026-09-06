# mailer.Dockerfile — NoLnk Mailer üretim imajı (çok aşamalı).
# NoLnk backend.Dockerfile ile AYNI desen: better-sqlite3 native derleme deps aşamasında yapılır,
# runner aşamasına yalnız derlenmiş node_modules + kod taşınır (slim imaj).

# --- Aşama 1: Bağımlılıkları kur (native derleme) ---
FROM node:20-slim AS deps
WORKDIR /app
# better-sqlite3 C++ eklentisi için derleme araçları
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# --- Aşama 2: Çalışma imajı ---
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# SQLite kalıcı dizini (compose'da volume bağlanır). db.js MAILER_DB_PATH'i okur.
ENV MAILER_DB_PATH=/data/mailer.sqlite
RUN mkdir -p /data
EXPOSE 5980
CMD ["node", "server.js"]
