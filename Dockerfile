FROM apify/actor-node-playwright:20
WORKDIR /usr/src/app

# Copy the whole repo
COPY . ./

# Install deps: prefer ci when lockfile exists, else install
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

CMD ["npm", "start"]
