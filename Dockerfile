FROM node:18-alpine

WORKDIR /app

# Install curl for health checks
RUN apk add --no-cache curl

# Copy package files
COPY package*.json ./

# Install dependencies
# Use npm ci if package-lock.json exists, otherwise use npm install
RUN if [ -f package-lock.json ]; then \
      npm ci --only=production; \
    else \
      npm install --only=production; \
    fi

# Copy application code
COPY . .

# Make health check script executable
RUN chmod +x healthcheck.sh

# Create uploads directory with proper permissions
RUN mkdir -p uploads && chmod 755 uploads

# Expose port (default 3000, can be overridden via PORT env variable at runtime)
EXPOSE 3000

# Set NODE_ENV to production if not set
ENV NODE_ENV=production

# Health check - uses PORT env variable or defaults to 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD ./healthcheck.sh

# Start application
CMD ["node", "src/server.js"]

