# Lathe-Sculptor - Railway Deployment
FROM node:20-slim

# Install build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy all source files (no separate layer caching for package.json)
COPY . .

# Install all dependencies (including devDependencies for build)
RUN npm install --no-optional

# Build the application
RUN npm run build

# Expose port (Railway uses PORT env var)
EXPOSE ${PORT:-5000}

# Start the application
CMD ["npm", "run", "start"]
