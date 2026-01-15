FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Build
RUN npm run build

ENV NODE_ENV=production
ENV PORT=4566

EXPOSE 4566

CMD ["node", "dist/index.js"]
