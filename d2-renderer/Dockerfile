FROM node:20-slim

# Install D2
RUN apt-get update && \
  apt-get install -y curl make build-essential && \
  curl -fsSL https://d2lang.com/install.sh | sh -s -- && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY index.js ./

# Create temp directory
RUN mkdir -p /tmp

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Run as non-root user
USER node

# Start application
CMD ["node", "index.js"]
