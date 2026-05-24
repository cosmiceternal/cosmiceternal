# Portable image for any container host (Fly.io, Railway, Cloud Run, a VPS…).
#   docker build -t neonstake .
#   docker run -p 3000:3000 -e SESSION_SECRET=$(openssl rand -hex 32) neonstake
# Uses the full node image so better-sqlite3's native bits build reliably.
FROM node:20-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Persist the SQLite database on a mounted volume in production.
ENV DB_PATH=/data/neonstake.db
VOLUME ["/data"]

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
