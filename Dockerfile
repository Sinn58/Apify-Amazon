# Apify-offizielles Playwright-Image mit Chromium
FROM apify/actor-node-playwright-chrome:20

# Abhängigkeiten kopieren und installieren (mit korrekten Berechtigungen)
COPY --chown=myuser:myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Playwright-Browser bereits im Base-Image vorhanden"

# Quellcode kopieren
COPY --chown=myuser:myuser . ./

# Actor starten
CMD npm start