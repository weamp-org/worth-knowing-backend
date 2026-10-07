/*
  Warnings:

  - The primary key for the `ResourceReport` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- AlterTable
ALTER TABLE "ResourceReport" DROP CONSTRAINT "ResourceReport_pkey",
ADD CONSTRAINT "ResourceReport_pkey" PRIMARY KEY ("reporterId", "resourceId");
