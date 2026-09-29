/*
  Warnings:

  - A unique constraint covering the columns `[usernameLower]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ReservedUsernameReason" AS ENUM ('RESERVED', 'RELEASED');

-- DropIndex
DROP INDEX "Resource_contributorId_idx";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "bio" VARCHAR(280),
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "isProfilePrivate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "username" VARCHAR(24),
ADD COLUMN     "usernameLower" TEXT;

-- CreateTable
CREATE TABLE "ReservedUsername" (
    "usernameLower" TEXT NOT NULL,
    "reason" "ReservedUsernameReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReservedUsername_pkey" PRIMARY KEY ("usernameLower")
);

-- CreateIndex
CREATE INDEX "Resource_contributorId_createdAt_id_idx" ON "Resource"("contributorId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "User_usernameLower_key" ON "User"("usernameLower");
