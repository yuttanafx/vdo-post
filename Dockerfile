FROM node:22-slim
# ffmpeg ใช้ทำภาพปกและอ่านความยาวคลิป
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
# โฟลเดอร์ข้อมูลต้องเป็นของผู้ใช้ node ก่อนประกาศ VOLUME เพื่อให้ volume ใหม่เขียนได้
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
