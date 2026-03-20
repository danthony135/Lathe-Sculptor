#!/bin/sh
echo "Running database migrations..."
npx drizzle-kit push 2>&1 || echo "Migration warning (non-fatal)"
echo "Starting application..."
exec node dist/index.cjs
