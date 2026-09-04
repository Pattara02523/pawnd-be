FROM node:22-bookworm-slim

WORKDIR /app

# ติดตั้ง OpenSSL สำหรับ Prisma Engine และ build tools
RUN apt-get update -y && apt-get install -y openssl python3 make g++ && rm -rf /var/lib/apt/lists/*

# ติดตั้ง pnpm
RUN npm install -g pnpm@11

# คัดลอก package files สำหรับ cache layer
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./

# ติดตั้ง dependencies ทั้งหมด
RUN pnpm install --frozen-lockfile

# คัดลอกซอร์สโค้ดและคอนฟิกทั้งหมด
COPY . .

# Generate Prisma Client
RUN pnpm prisma generate

# Build NestJS โปรเจกต์
RUN pnpm build

ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

# รัน migration อัตโนมัติและสตาร์ท production server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main"]