FROM node:18-slim

RUN apt-get update && apt-get install -y \
    g++ \
    make \
    cmake \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]
