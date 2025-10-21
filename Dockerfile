# Use Apify’s official Node + Playwright image (best for Crawlee)
FROM apify/actor-node-playwright:20

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the source code
COPY . ./

# Default command for Apify
CMD ["npm", "start"]
