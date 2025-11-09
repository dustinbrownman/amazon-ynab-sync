# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for building)
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY *.ts ./

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Run the application
CMD [ "node", "dist/index.js" ]
