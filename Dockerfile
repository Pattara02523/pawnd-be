# -------------------------------------------------------------
# Stage 1: Build & Dependencies
# -------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# ติดตั้ง OpenSSL สำหรับ Prisma Engine และ build tools
RUN apt-get update -y && apt-get install -y openssl python3 make g++ && rm -rf /var/lib/apt/lists/*

# ติดตั้ง pnpm
RUN npm install -g pnpm@11

# คัดลอกเฉพาะไฟล์ Dependency สำหรับ cache layer
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./

# ติดตั้ง Dependencies ทั้งหมด
RUN pnpm install --frozen-lockfile

# คัดลอกซอร์สโค้ดและไฟล์คอนฟิกทั้งหมด (รวม tsconfig.json, prisma.config.ts, schema)
COPY . .

# Generate Prisma Client (อ่าน tsconfig.json ทำให้สร้าง import .js ถูกต้อง)
RUN pnpm prisma generate

# Build NestJS โปรเจกต์
RUN pnpm build

# -------------------------------------------------------------
# Stage 2: Production Runner
# -------------------------------------------------------------
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8000

# ติดตั้ง OpenSSL สำหรับ Prisma
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# ติดตั้ง pnpm
RUN npm install -g pnpm@11

# คัดลอก node_modules, generated prisma client และ dist จาก builder stage
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/src/database/generated ./src/database/generated

EXPOSE 8000

# รัน migration อัตโนมัติด้วย npx prisma และสตาร์ท production server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main"]