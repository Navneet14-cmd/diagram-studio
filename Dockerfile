# syntax=docker/dockerfile:1

# --- deps: install production dependencies, keep only what the browser is served ---
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && mkdir -p /out \
 && for p in mermaid dompurify lucide @fontsource-variable/space-grotesk; do \
      mkdir -p "/out/$p" && cp -r "node_modules/$p/." "/out/$p/"; \
    done \
 && find /out -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete \
 && rm -rf /out/mermaid/dist/docs /out/mermaid/dist/__mocks__ /out/lucide/dist/esm /out/lucide/dist/cjs

# --- runtime: small image, non-root user, no npm needed at runtime ---
FROM node:22-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
COPY --from=deps --chown=node:node /out ./node_modules
COPY --chown=node:node package.json LICENSE THIRD_PARTY_LICENSES.md ./
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --chown=node:node public ./public
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/server.mjs"]
