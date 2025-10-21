FROM apify/actor-node-playwright:20
WORKDIR /usr/src/app

# Copy code as root, then give it to myuser
USER root
COPY . ./
RUN chown -R myuser:myuser /usr/src/app

# Switch to non-root for installs & runtime
USER myuser

# Install deps: use ci if lockfile exists, else install without creating a lockfile
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund --no-package-lock; \
    fi

CMD ["npm", "start"]
