# slim: no native compilation needed (gm uses graphicsmagick, ffmpeg-static ships a binary); git is required
# for the rustplus.js git dependency
FROM node:26-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates graphicsmagick \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json /app/package.json
COPY package-lock.json /app/package-lock.json
RUN npm ci
COPY . /app

VOLUME [ "/app/credentials" ]
VOLUME [ "/app/instances" ]
VOLUME [ "/app/logs" ]
VOLUME [ "/app/maps" ]

# HTTP API (enabled by RPP_API_TOKEN)
EXPOSE 24343

CMD ["npm", "start"]
