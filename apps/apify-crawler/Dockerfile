# ---- build stage ----
FROM apify/actor-node-playwright:20 AS build
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --no-audit --no-fund --include=dev

COPY . ./
RUN npm run build

# ---- runtime stage ----
FROM apify/actor-node-playwright:20
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --no-audit --no-fund --omit=dev

COPY --from=build /usr/src/app/dist ./dist

CMD ["npm", "run", "start:prod"]
