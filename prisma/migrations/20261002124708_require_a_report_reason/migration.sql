/*
  Warnings:

  - Added the required column `reason` to the `CommentReport` table without a default value. This is not possible if the table is not empty.
  - Added the required column `reason` to the `ResourceReport` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ResourceReportReason" AS ENUM ('SPAM', 'ABUSE', 'BROKEN_LINK', 'WRONG_RESOURCE', 'SOMETHING_ELSE');

-- CreateEnum
CREATE TYPE "CommentReportReason" AS ENUM ('SPAM', 'ABUSE', 'OFF_TOPIC', 'SOMETHING_ELSE');

-- AlterTable
ALTER TABLE "CommentReport" ADD COLUMN     "detail" VARCHAR(500),
DROP COLUMN "reason",
ADD COLUMN     "reason" "CommentReportReason" NOT NULL;

-- AlterTable
ALTER TABLE "ResourceReport" ADD COLUMN     "detail" VARCHAR(500),
DROP COLUMN "reason",
ADD COLUMN     "reason" "ResourceReportReason" NOT NULL;
