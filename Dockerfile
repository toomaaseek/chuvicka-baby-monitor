FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DB=/data/chuvicka.db PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY lib ./lib
COPY public ./public
# Model YAMNet pro rozpoznání pláče (Apache 2.0, Google) — do gitu se
# nedává, stáhne se při sestavení a ověří.
RUN wget -q -O public/vendor/yamnet.tflite https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite \
 && echo "4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf  public/vendor/yamnet.tflite" | sha256sum -c -
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
