FROM apify/actor-node-playwright:20
WORKDIR /usr/src/app

USER root
COPY . ./
RUN chown -R myuser:myuser /usr/src/app

USER myuser
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund --no-package-lock; \
    fi

CMD ["npm", "start"]
