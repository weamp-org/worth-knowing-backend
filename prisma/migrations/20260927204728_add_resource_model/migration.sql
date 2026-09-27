-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('ARTICLE', 'BOOK', 'COURSE', 'VIDEO', 'PODCAST', 'PLAYLIST', 'TOOL', 'RESEARCH_PAPER', 'DATASET', 'WEBSITE', 'OTHER');

-- CreateEnum
CREATE TYPE "AccessType" AS ENUM ('FREE', 'PAID', 'FREEMIUM', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "url" TEXT NOT NULL,
    "type" "ResourceType" NOT NULL,
    "accessType" "AccessType" NOT NULL DEFAULT 'UNKNOWN',
    "why" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "contributorId" TEXT,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Resource_contributorId_idx" ON "Resource"("contributorId");

-- CreateIndex
CREATE INDEX "Resource_createdAt_idx" ON "Resource"("createdAt");

-- CreateIndex
CREATE INDEX "Resource_type_createdAt_idx" ON "Resource"("type", "createdAt");

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_contributorId_fkey" FOREIGN KEY ("contributorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
