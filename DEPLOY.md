# ขึ้นเซิร์ฟเวอร์ (VPS)

โครงสร้าง: Docker Compose = แอป (Node) + Caddy (HTTPS อัตโนมัติ) ข้อมูลทั้งหมดอยู่ใน Docker volume

**ที่ต้องมี:** VPS (Ubuntu 22.04+ ขึ้นไป, RAM 1 GB+, ดิสก์พอสำหรับคลิป) และโดเมนที่ชี้มาที่ VPS

## 1. ส่งโค้ดขึ้น GitHub (ทำที่เครื่องคุณ)

สร้าง repo เปล่าแบบ **Private** บน GitHub (ไม่ต้องติ๊กสร้าง README) แล้วรันในโฟลเดอร์โปรเจกต์:

```bash
git remote add origin git@github.com:<ชื่อคุณ>/klangklip.git
git push -u origin main
```

ไฟล์ `.env` และโฟลเดอร์ `data/` ถูกกันไว้ใน `.gitignore` แล้ว จะไม่ขึ้น GitHub

## 2. เตรียม VPS (ครั้งแรกครั้งเดียว)

```bash
curl -fsSL https://get.docker.com | sh          # ติดตั้ง Docker
sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

ตั้ง DNS: เพิ่ม **A record** ของโดเมน (เช่น `clips.example.com`) ชี้ไปที่ IP ของ VPS แล้วรอให้มีผล

## 3. ติดตั้งและรัน

```bash
git clone git@github.com:<ชื่อคุณ>/klangklip.git && cd klangklip   # repo private ต้องตั้ง deploy key หรือใช้ HTTPS + token
cp .env.example .env
openssl rand -hex 32     # รันสองครั้ง นำไปใส่ TOKEN_KEY และ SESSION_KEY
nano .env                # แก้ DOMAIN, ADMIN_EMAIL, ADMIN_PASSWORD, กุญแจ, FB_*
docker compose up -d --build
docker compose logs -f app      # ต้องเห็น "คลังคลิป รันที่ http://localhost:3000"
```

เปิด `https://โดเมนของคุณ` ล็อกอินด้วย `ADMIN_EMAIL` / `ADMIN_PASSWORD` (Caddy ขอใบรับรองครั้งแรกใช้เวลาไม่กี่สิบวินาที)

## 4. ตั้งค่าแอป Facebook

ที่ developers.facebook.com ใส่ Valid OAuth Redirect URI เป็น
`https://โดเมนของคุณ/api/oauth/facebook/callback` (ต้องตรงกับ `FB_REDIRECT_URI` ใน `.env` ทุกตัวอักษร)
รายละเอียดสิทธิ์และการรีวิวอยู่ใน `README.md`

## 5. อัปเดตเวอร์ชัน

```bash
git pull && docker compose up -d --build
```

ข้อมูลอยู่ใน volume จึงไม่หายเมื่ออัปเดต

## 6. สำรองข้อมูล (ทำเป็นประจำ)

```bash
docker volume ls | grep data          # ดูชื่อ volume เช่น klangklip_data
docker run --rm -v klangklip_data:/data -v "$PWD":/backup alpine tar czf /backup/klangklip-$(date +%F).tgz -C / data
```

เก็บไฟล์ `.tgz` และไฟล์ `.env` ไว้นอก VPS **ถ้า `TOKEN_KEY` หาย สมาชิกต้องเชื่อมบัญชีโซเชียลใหม่ทั้งหมด**

## ข้อควรระวัง

- รันแอปได้ **ตัวเดียว** (ข้อมูลเป็นไฟล์ JSON อย่าเปิดหลาย replica) ถ้าสมาชิกเยอะขึ้นควรย้ายไปฐานข้อมูลจริง
- อย่าเปิดพอร์ต 3000 สู่อินเทอร์เน็ต ให้ผ่าน Caddy เท่านั้น (compose ตั้งไว้ถูกแล้ว) เพราะ `TRUST_PROXY=1` เชื่อค่า IP จากพร็อกซี
- คลิปอยู่บนดิสก์ VPS ดูพื้นที่ด้วย `df -h` ถ้าใกล้เต็มให้ขยายดิสก์หรือย้ายไป object storage
- ไฟล์ Docker ในชุดนี้ผมยังไม่ได้ทดสอบ build จริง (เครื่องที่เตรียมไม่มี Docker) ถ้า build ไม่ผ่านให้ส่ง log กลับมา
